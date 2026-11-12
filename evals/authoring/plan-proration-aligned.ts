import type { AuthoredCase } from './build';

const KT = 'billing/src/main/kotlin/com/acme/billing';

/** Kotlin is outside the AST languages, so this case also exercises the ±20 line fallback. */
export const planProrationAligned: AuthoredCase = {
  id: 'plan-proration-aligned',
  pr: {
    number: 2015,
    title: 'Prorated plan upgrades, downgrades at renewal',
    author: 'sven',
    headRef: 'feat/plan-proration',
    body: `
Closes #1915

Upgrades charge the prorated difference right away; downgrades are scheduled for the renewal date.
The plan is switched only after the charge succeeds.
`,
  },
  prd: [
    {
      source: 'github',
      id: 'acme/shop#1915',
      url: 'https://github.com/acme/shop/issues/1915',
      title: 'Change subscription plans mid-cycle',
      acceptanceCriteria: [
        'AC1: Upgrading mid-cycle charges the price difference prorated by the days left in the billing cycle, rounded half up to the cent.',
        'AC2: A downgrade takes effect on the next renewal date and nothing is refunded.',
        'AC3: An upgrade on the last day of the cycle charges the difference for that one day.',
        'AC4: If the card charge for an upgrade fails, the plan stays unchanged and the error PAYMENT_FAILED is returned.',
      ],
      body: `
Customers who upgrade today wait until renewal, and support issues manual credits.

### Acceptance Criteria
- AC1: Upgrading mid-cycle charges the price difference prorated by the days left in the billing cycle, rounded half up to the cent.
- AC2: A downgrade takes effect on the next renewal date and nothing is refunded.
- AC3: An upgrade on the last day of the cycle charges the difference for that one day.
- AC4: If the card charge for an upgrade fails, the plan stays unchanged and the error PAYMENT_FAILED is returned.

The renewal date is the first day of the next cycle; a cycle runs from its start date up to, but not including, the renewal date.
`,
    },
  ],
  files: [
    {
      path: `${KT}/Proration.kt`,
      content: `
package com.acme.billing

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.temporal.ChronoUnit

object Proration {
    /**
     * Price difference for the rest of the cycle, in cents. The cycle is [cycleStart, renewal),
     * so on the last day of the cycle one day is left.
     */
    fun upgradeChargeCents(
        oldPriceCents: Long,
        newPriceCents: Long,
        cycleStart: LocalDate,
        renewal: LocalDate,
        today: LocalDate,
    ): Long {
        require(newPriceCents > oldPriceCents) { "not an upgrade" }
        require(!today.isBefore(cycleStart) && today.isBefore(renewal)) { "today is outside the cycle" }
        val cycleDays = ChronoUnit.DAYS.between(cycleStart, renewal)
        val daysLeft = ChronoUnit.DAYS.between(today, renewal)
        return BigDecimal.valueOf(newPriceCents - oldPriceCents)
            .multiply(BigDecimal.valueOf(daysLeft))
            .divide(BigDecimal.valueOf(cycleDays), 0, RoundingMode.HALF_UP)
            .longValueExact()
    }
}
`,
    },
    {
      path: `${KT}/PlanChangeService.kt`,
      diff: `
 package com.acme.billing

 import java.time.Clock
 import java.time.LocalDate

 class PlanChangeService(
     private val subscriptions: SubscriptionRepository,
     private val plans: PlanCatalog,
+    private val payments: PaymentGateway,
     private val clock: Clock,
 ) {
-    fun changePlan(subscriptionId: String, newPlanId: String) {
-        val sub = subscriptions.get(subscriptionId)
-        subscriptions.save(sub.copy(planId = newPlanId))
-    }
+    fun changePlan(subscriptionId: String, newPlanId: String): PlanChangeResult {
+        val sub = subscriptions.get(subscriptionId)
+        val current = plans.get(sub.planId)
+        val target = plans.get(newPlanId)
+        val today = LocalDate.now(clock)
+
+        if (target.priceCents < current.priceCents) {
+            subscriptions.save(sub.copy(pendingPlanId = newPlanId))
+            return PlanChangeResult.Scheduled(effectiveOn = sub.renewalDate)
+        }
+
+        val charge = Proration.upgradeChargeCents(
+            current.priceCents, target.priceCents, sub.cycleStart, sub.renewalDate, today,
+        )
+        val paid = payments.charge(sub.customerId, charge, "upgrade:" + subscriptionId)
+        if (!paid.succeeded) {
+            return PlanChangeResult.Failed(code = "PAYMENT_FAILED")
+        }
+        subscriptions.save(sub.copy(planId = newPlanId, pendingPlanId = null))
+        return PlanChangeResult.Upgraded(chargedCents = charge)
+    }
 }
+
+sealed interface PlanChangeResult {
+    data class Upgraded(val chargedCents: Long) : PlanChangeResult
+    data class Scheduled(val effectiveOn: LocalDate) : PlanChangeResult
+    data class Failed(val code: String) : PlanChangeResult
+}
`,
    },
    {
      path: `${KT}/RenewalJob.kt`,
      diff: `
 package com.acme.billing

 import java.time.Clock
 import java.time.LocalDate

 class RenewalJob(
     private val subscriptions: SubscriptionRepository,
     private val billing: RenewalBilling,
     private val clock: Clock,
 ) {
     fun renewDue() {
         val today = LocalDate.now(clock)
         for (sub in subscriptions.dueOn(today)) {
-            billing.chargeRenewal(sub)
-            subscriptions.save(sub.copy(cycleStart = today, renewalDate = today.plusMonths(1)))
+            // A downgrade scheduled during the last cycle starts with the new cycle.
+            val planId = sub.pendingPlanId ?: sub.planId
+            billing.chargeRenewal(sub.copy(planId = planId))
+            subscriptions.save(
+                sub.copy(planId = planId, pendingPlanId = null, cycleStart = today, renewalDate = today.plusMonths(1)),
+            )
         }
     }
 }
`,
    },
    {
      path: `${KT}/PlanController.kt`,
      diff: `
 package com.acme.billing

 class PlanController(private val service: PlanChangeService) {
-    fun change(req: Request): Response {
-        service.changePlan(req.pathParam("id"), req.bodyField("planId"))
-        return Response.noContent()
-    }
+    fun change(req: Request): Response =
+        when (val result = service.changePlan(req.pathParam("id"), req.bodyField("planId"))) {
+            is PlanChangeResult.Upgraded -> Response.ok(mapOf("charged" to result.chargedCents))
+            is PlanChangeResult.Scheduled -> Response.accepted(mapOf("effectiveOn" to result.effectiveOn.toString()))
+            is PlanChangeResult.Failed -> Response.status(402, mapOf("error" to result.code))
+        }
 }
`,
    },
  ],
  expected: {
    expectedAlignment: 'aligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Prorated upgrade charge, half-up to the cent',
        labels: ['AC1'],
        keywords: ['prorated', 'half up'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Downgrade at next renewal, no refund',
        labels: ['AC2'],
        keywords: ['downgrade'],
        accept: ['covered'],
      },
      {
        id: 'AC3',
        requirement: 'Last-day upgrade charges one day',
        labels: ['AC3'],
        keywords: ['last day'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Failed charge leaves the plan unchanged; PAYMENT_FAILED',
        labels: ['AC4'],
        keywords: ['PAYMENT_FAILED', 'card charge'],
        accept: ['covered'],
      },
    ],
    mustScenarios: [
      {
        id: 'proration-amount',
        risk: 'Upgrading from 10.00 to 25.00 with 10 of 30 days left charges 5.00; a difference that does not divide evenly rounds half up',
        keywords: [['prorat', 'days left', 'remaining days', 'half up', 'half-up', 'round']],
      },
      {
        id: 'last-day',
        risk: 'An upgrade on the day before the renewal date charges exactly one day of the difference',
        keywords: [['last day', 'one day', '1 day', 'day before renewal', 'final day']],
      },
      {
        id: 'first-day',
        risk: 'An upgrade on the first day of the cycle charges the full difference',
        keywords: [['first day', 'full difference', 'whole cycle', 'start of the cycle', 'cycle start']],
      },
      {
        id: 'downgrade',
        risk: 'A downgrade keeps the current plan until the renewal date, schedules the new one and refunds nothing',
        keywords: [['downgrade']],
      },
      {
        id: 'payment-failure',
        risk: 'A declined card returns PAYMENT_FAILED (402) and the subscription keeps its old plan',
        keywords: [['payment_failed', 'declin', 'charge fails', 'payment fails', 'failed charge', '402']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Coupons, trials and annual billing are in neither the issue nor the code',
        patterns: ['free trial', 'annual plan', 'yearly plan', 'coupon'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['billing', 'kotlin', 'boundary', 'aligned'],
    notes:
      'Fully implemented: proration by days left with half-up rounding, scheduled downgrades, plan switched only after a successful charge.',
  },
};
