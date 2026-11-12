import type { AuthoredCase } from './build';

const PKG = 'src/main/java/com/acme/payroll';

/**
 * Large multi-file PR (12 files) meant to run through map-reduce with a small token budget.
 * The night window in NightPremiumRule is the planted contradiction; the payslip job has no retry.
 */
export const payrollRulesMapreduce: AuthoredCase = {
  id: 'payroll-rules-mapreduce',
  split: 'dev',
  options: { tokenBudget: 10000 },
  pr: {
    number: 2009,
    title: 'Payroll rules engine: overtime, night and holiday pay',
    author: 'olga',
    headRef: 'feat/payroll-rules',
    body: `
Spec: https://www.notion.so/acme/Payroll-rules-2027-5b8e2f1a0c9d4b7e9f3a6c2d1e8b4a70

Replaces the spreadsheet formulas with PayCalculator and three pay rules. Each rule turns the
week's shifts into pay lines; the payslip job renders one PDF per employee.
`,
  },
  prd: [
    {
      source: 'notion',
      id: '5b8e2f1a0c9d4b7e9f3a6c2d1e8b4a70',
      url: 'https://www.notion.so/acme/Payroll-rules-2027-5b8e2f1a0c9d4b7e9f3a6c2d1e8b4a70',
      title: 'Payroll rules 2027',
      acceptanceCriteria: [
        'AC1: Hours beyond 40 in a calendar week (Monday to Sunday) are paid at 1.5 times the base rate.',
        'AC2: Hours worked between 22:00 and 06:00 earn a night premium of 50% of the base rate on top of the regular pay.',
        'AC3: Hours on a public holiday are paid at 2 times the base rate, and holiday hours do not count toward the 40-hour overtime threshold.',
        'AC4: When rendering a payslip PDF fails, the job retries that payslip up to 3 times and then marks it FAILED so the other payslips still go out.',
      ],
      body: `
# Payroll rules 2027

Works council agreement signed in October. Payroll currently runs from a spreadsheet that only
the payroll lead understands.

## Acceptance Criteria
- AC1: Hours beyond 40 in a calendar week (Monday to Sunday) are paid at 1.5 times the base rate.
- AC2: Hours worked between 22:00 and 06:00 earn a night premium of 50% of the base rate on top of the regular pay.
- AC3: Hours on a public holiday are paid at 2 times the base rate, and holiday hours do not count toward the 40-hour overtime threshold.
- AC4: When rendering a payslip PDF fails, the job retries that payslip up to 3 times and then marks it FAILED so the other payslips still go out.

## Rounding
Amounts are calculated in cents; each pay line is rounded half up to the cent.
`,
    },
  ],
  files: [
    {
      path: `${PKG}/model/Shift.java`,
      content: `
package com.acme.payroll.model;

import java.time.Duration;
import java.time.LocalDateTime;

/** One continuous block of work. A shift may cross midnight. */
public record Shift(String employeeId, LocalDateTime start, LocalDateTime end) {
    public Shift {
        if (!end.isAfter(start)) {
            throw new IllegalArgumentException("shift must end after it starts");
        }
    }

    public long minutes() {
        return Duration.between(start, end).toMinutes();
    }
}
`,
    },
    {
      path: `${PKG}/model/Employee.java`,
      content: `
package com.acme.payroll.model;

/** Base rate is stored in cents per hour. */
public record Employee(String id, String name, long baseRateCentsPerHour) {}
`,
    },
    {
      path: `${PKG}/model/PayLine.java`,
      content: `
package com.acme.payroll.model;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** A priced line on the payslip, e.g. "Overtime 3.5 h x 1.5". */
public record PayLine(String label, long minutes, BigDecimal rateFactor, long amountCents) {
    public static PayLine of(String label, long minutes, BigDecimal rateFactor, long baseRateCentsPerHour) {
        BigDecimal hours = BigDecimal.valueOf(minutes).divide(BigDecimal.valueOf(60), 10, RoundingMode.HALF_UP);
        BigDecimal cents = hours.multiply(rateFactor).multiply(BigDecimal.valueOf(baseRateCentsPerHour));
        return new PayLine(label, minutes, rateFactor, cents.setScale(0, RoundingMode.HALF_UP).longValueExact());
    }
}
`,
    },
    {
      path: `${PKG}/calendar/HolidayCalendar.java`,
      content: `
package com.acme.payroll.calendar;

import java.time.LocalDate;
import java.util.Set;

/** Public holidays for the payroll region, loaded once per year from the HR system. */
public final class HolidayCalendar {
    private final Set<LocalDate> holidays;

    public HolidayCalendar(Set<LocalDate> holidays) {
        this.holidays = Set.copyOf(holidays);
    }

    public boolean isHoliday(LocalDate date) {
        return holidays.contains(date);
    }
}
`,
    },
    {
      path: `${PKG}/calc/PayRule.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.util.List;

/** Turns one employee's shifts for one calendar week into pay lines. */
public interface PayRule {
    List<PayLine> apply(Employee employee, List<Shift> weekShifts);
}
`,
    },
    {
      path: `${PKG}/calc/MinuteSplitter.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.calendar.HolidayCalendar;
import com.acme.payroll.model.Shift;
import java.time.LocalDateTime;
import java.util.List;
import java.util.function.Predicate;

/** Counts the minutes of shifts that satisfy a per-minute condition. */
final class MinuteSplitter {
    private MinuteSplitter() {}

    static long count(List<Shift> shifts, Predicate<LocalDateTime> minuteMatches) {
        long total = 0;
        for (Shift s : shifts) {
            for (LocalDateTime t = s.start(); t.isBefore(s.end()); t = t.plusMinutes(1)) {
                if (minuteMatches.test(t)) {
                    total++;
                }
            }
        }
        return total;
    }

    static Predicate<LocalDateTime> onHoliday(HolidayCalendar calendar) {
        return t -> calendar.isHoliday(t.toLocalDate());
    }
}
`,
    },
    {
      path: `${PKG}/calc/OvertimeRule.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.calendar.HolidayCalendar;
import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/** Regular and overtime pay. Holiday minutes are paid by HolidayRule and skipped here. */
public final class OvertimeRule implements PayRule {
    static final long WEEKLY_THRESHOLD_MINUTES = 40 * 60;
    static final BigDecimal OVERTIME_FACTOR = new BigDecimal("1.5");

    private final HolidayCalendar calendar;

    public OvertimeRule(HolidayCalendar calendar) {
        this.calendar = calendar;
    }

    @Override
    public List<PayLine> apply(Employee employee, List<Shift> weekShifts) {
        long worked = MinuteSplitter.count(weekShifts, MinuteSplitter.onHoliday(calendar).negate());
        long regular = Math.min(worked, WEEKLY_THRESHOLD_MINUTES);
        long overtime = Math.max(0, worked - WEEKLY_THRESHOLD_MINUTES);
        List<PayLine> lines = new ArrayList<>();
        lines.add(PayLine.of("Regular", regular, BigDecimal.ONE, employee.baseRateCentsPerHour()));
        if (overtime > 0) {
            lines.add(PayLine.of("Overtime", overtime, OVERTIME_FACTOR, employee.baseRateCentsPerHour()));
        }
        return lines;
    }
}
`,
    },
    {
      path: `${PKG}/calc/NightPremiumRule.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.math.BigDecimal;
import java.time.LocalTime;
import java.util.List;

/** Night premium paid on top of regular, overtime and holiday pay. */
public final class NightPremiumRule implements PayRule {
    static final LocalTime NIGHT_START = LocalTime.of(22, 0);
    static final LocalTime NIGHT_END = LocalTime.of(5, 0);
    static final BigDecimal NIGHT_FACTOR = new BigDecimal("0.5");

    @Override
    public List<PayLine> apply(Employee employee, List<Shift> weekShifts) {
        long nightMinutes = MinuteSplitter.count(weekShifts, t -> {
            LocalTime time = t.toLocalTime();
            return !time.isBefore(NIGHT_START) || time.isBefore(NIGHT_END);
        });
        if (nightMinutes == 0) {
            return List.of();
        }
        return List.of(PayLine.of("Night premium", nightMinutes, NIGHT_FACTOR, employee.baseRateCentsPerHour()));
    }
}
`,
    },
    {
      path: `${PKG}/calc/HolidayRule.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.calendar.HolidayCalendar;
import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.math.BigDecimal;
import java.util.List;

/** Holiday minutes at double rate. */
public final class HolidayRule implements PayRule {
    static final BigDecimal HOLIDAY_FACTOR = new BigDecimal("2");

    private final HolidayCalendar calendar;

    public HolidayRule(HolidayCalendar calendar) {
        this.calendar = calendar;
    }

    @Override
    public List<PayLine> apply(Employee employee, List<Shift> weekShifts) {
        long holidayMinutes = MinuteSplitter.count(weekShifts, MinuteSplitter.onHoliday(calendar));
        if (holidayMinutes == 0) {
            return List.of();
        }
        return List.of(PayLine.of("Holiday", holidayMinutes, HOLIDAY_FACTOR, employee.baseRateCentsPerHour()));
    }
}
`,
    },
    {
      path: `${PKG}/calc/PayCalculator.java`,
      content: `
package com.acme.payroll.calc;

import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Groups shifts by calendar week (Monday to Sunday) and applies every rule per week. */
public final class PayCalculator {
    private final List<PayRule> rules;

    public PayCalculator(List<PayRule> rules) {
        this.rules = List.copyOf(rules);
    }

    public List<PayLine> calculate(Employee employee, List<Shift> periodShifts) {
        Map<LocalDate, List<Shift>> byWeek = new TreeMap<>();
        for (Shift s : periodShifts) {
            for (Shift part : splitAtWeekStart(s)) {
                LocalDate monday = part.start().toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
                byWeek.computeIfAbsent(monday, k -> new ArrayList<>()).add(part);
            }
        }
        List<PayLine> lines = new ArrayList<>();
        for (List<Shift> week : byWeek.values()) {
            for (PayRule rule : rules) {
                lines.addAll(rule.apply(employee, week));
            }
        }
        return lines;
    }

    /** A shift running past Monday 00:00 is cut there, so each part lands in its own week. */
    static List<Shift> splitAtWeekStart(Shift s) {
        List<Shift> parts = new ArrayList<>();
        LocalDateTime start = s.start();
        while (true) {
            LocalDateTime nextMonday = start.toLocalDate().with(TemporalAdjusters.next(DayOfWeek.MONDAY)).atStartOfDay();
            if (!s.end().isAfter(nextMonday)) {
                parts.add(new Shift(s.employeeId(), start, s.end()));
                return parts;
            }
            parts.add(new Shift(s.employeeId(), start, nextMonday));
            start = nextMonday;
        }
    }

    public static long total(List<PayLine> lines) {
        return lines.stream().mapToLong(PayLine::amountCents).sum();
    }
}
`,
    },
    {
      path: `${PKG}/payslip/PayslipJob.java`,
      content: `
package com.acme.payroll.payslip;

import com.acme.payroll.calc.PayCalculator;
import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import java.time.YearMonth;
import java.util.List;

/** Renders and stores the monthly payslip of every employee. */
public final class PayslipJob {
    private final PayCalculator calculator;
    private final PayslipRenderer renderer;
    private final PayslipStore store;
    private final ShiftSource shifts;

    public PayslipJob(PayCalculator calculator, PayslipRenderer renderer, PayslipStore store, ShiftSource shifts) {
        this.calculator = calculator;
        this.renderer = renderer;
        this.store = store;
        this.shifts = shifts;
    }

    public void run(YearMonth month, List<Employee> employees) {
        for (Employee e : employees) {
            List<PayLine> lines = calculator.calculate(e, shifts.forMonth(e.id(), month));
            byte[] pdf = renderer.render(e, month, lines);
            store.save(e.id(), month, pdf, PayCalculator.total(lines));
        }
    }
}
`,
    },
    {
      path: `${PKG}/payslip/PayslipRenderer.java`,
      content: `
package com.acme.payroll.payslip;

import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import java.time.YearMonth;
import java.util.List;

/** Turns pay lines into a PDF through the document service; throws RenderException on failure. */
public interface PayslipRenderer {
    byte[] render(Employee employee, YearMonth month, List<PayLine> lines);

    final class RenderException extends RuntimeException {
        public RenderException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
`,
    },
    {
      path: 'src/test/java/com/acme/payroll/calc/PayCalculatorTest.java',
      content: `
package com.acme.payroll.calc;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.acme.payroll.calendar.HolidayCalendar;
import com.acme.payroll.model.Employee;
import com.acme.payroll.model.PayLine;
import com.acme.payroll.model.Shift;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class PayCalculatorTest {
    private final HolidayCalendar noHolidays = new HolidayCalendar(Set.of());
    private final PayCalculator calc = new PayCalculator(List.of(new OvertimeRule(noHolidays)));
    private final Employee ana = new Employee("e-1", "Ana", 2_000);

    @Test
    void paysFortyRegularHoursWithoutOvertime() {
        List<Shift> week = List.of(
            new Shift("e-1", LocalDateTime.parse("2027-01-04T08:00"), LocalDateTime.parse("2027-01-04T16:00")),
            new Shift("e-1", LocalDateTime.parse("2027-01-05T08:00"), LocalDateTime.parse("2027-01-05T16:00")),
            new Shift("e-1", LocalDateTime.parse("2027-01-06T08:00"), LocalDateTime.parse("2027-01-06T16:00")),
            new Shift("e-1", LocalDateTime.parse("2027-01-07T08:00"), LocalDateTime.parse("2027-01-07T16:00")),
            new Shift("e-1", LocalDateTime.parse("2027-01-08T08:00"), LocalDateTime.parse("2027-01-08T16:00")));
        List<PayLine> lines = calc.calculate(ana, week);
        assertEquals(1, lines.size());
        assertEquals(80_000, PayCalculator.total(lines));
    }
}
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Overtime at 1.5x beyond 40 hours per Monday–Sunday week',
        labels: ['AC1'],
        keywords: ['beyond 40', '1.5 times'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Night premium 50% for 22:00–06:00',
        labels: ['AC2'],
        keywords: ['night premium', '22:00 and 06:00'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: 'Holiday hours at 2x, excluded from the overtime threshold',
        labels: ['AC3'],
        keywords: ['public holiday', '2 times'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Payslip rendering retried 3 times, then FAILED without stopping the run',
        labels: ['AC4'],
        keywords: ['payslip PDF', 'marks it FAILED'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'night-0500-0600',
        risk: 'Work between 05:00 and 06:00 must earn the night premium, but NIGHT_END is 05:00 so that hour is unpaid',
        keywords: [['05:00', '5:00', '06:00', '6:00', 'night_end', '5 am', '6 am']],
      },
      {
        id: 'overtime-boundary',
        risk: 'Exactly 40 hours gives no overtime line; 40 h 30 min gives 30 overtime minutes at 1.5x',
        keywords: [['40'], ['overtime']],
      },
      {
        id: 'week-boundary',
        risk: 'A shift crossing Sunday midnight into Monday is split: hours before midnight count toward the old week, hours after toward the new one',
        keywords: [['sunday', 'monday', 'week boundary', 'midnight', 'crosses']],
      },
      {
        id: 'holiday-excluded',
        risk: 'A week with 8 holiday hours and 40 other hours has no overtime; holiday hours are paid 2x',
        keywords: [['holiday']],
      },
      {
        id: 'render-failure',
        risk: 'One payslip PDF fails to render: it is retried up to 3 times and marked FAILED while the rest of the run continues (today the exception stops the whole job)',
        keywords: [
          ['render', 'pdf', 'payslip'],
          ['fail', 'retry', 'exception', 'error'],
        ],
      },
      {
        id: 'rounding',
        risk: 'Fractional minutes and rates round half up to the cent on each pay line',
        keywords: [['round', 'half up', 'half-up', 'cent']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Tax withholding and sick pay are in neither the spec nor the code',
        patterns: ['withholding', 'sick pay', 'income tax'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['payroll', 'java', 'multi-file', 'map-reduce', 'boundary', 'contradicts', 'missing'],
    notes:
      'Map-reduce case (12 files). AC2 is contradicted (night window ends at 05:00, not 06:00) and AC4 is absent (PayslipJob has no retry or FAILED status; one render error stops the run).',
  },
};
