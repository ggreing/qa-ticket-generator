import type { AuthoredCase } from './build';

export const orderCancelStateJava: AuthoredCase = {
  id: 'order-cancel-state-java',
  pr: {
    number: 2001,
    title: 'Order status machine and cancellation endpoint',
    author: 'diego',
    headRef: 'feat/order-cancel',
    body: `
Implements https://acme.atlassian.net/browse/ORD-88

Moves status changes into Order.transitionTo() so every caller goes through the same rules,
and adds POST /orders/{id}/cancel. Cancelling a paid order refunds it through the gateway.
Also bumps the payment client and turns on the new cancel route in application.yml.
`,
  },
  prd: [
    {
      source: 'jira',
      id: 'ORD-88',
      url: 'https://acme.atlassian.net/browse/ORD-88',
      title: 'Order cancellation rules',
      acceptanceCriteria: [
        'AC1: An order moves only along PENDING → PAID → SHIPPED → DELIVERED; any other transition is rejected with IllegalStatusTransition.',
        'AC2: An order can be cancelled only while it is PENDING or PAID; cancelling a SHIPPED or DELIVERED order returns HTTP 409.',
        'AC3: Cancelling a PAID order refunds the full captured amount through the payment gateway.',
        'AC4: Every status change is written to the order_status_history table with the previous status, the new status and the actor id.',
      ],
      body: `
## Background
Customer support cancels orders by editing the database. We want one cancel endpoint with
clear rules, and a history of status changes for disputes.

## Acceptance Criteria
- AC1: An order moves only along PENDING → PAID → SHIPPED → DELIVERED; any other transition is rejected with IllegalStatusTransition.
- AC2: An order can be cancelled only while it is PENDING or PAID; cancelling a SHIPPED or DELIVERED order returns HTTP 409.
- AC3: Cancelling a PAID order refunds the full captured amount through the payment gateway.
- AC4: Every status change is written to the order_status_history table with the previous status, the new status and the actor id.

## Notes
Once the parcel is with the carrier, the warehouse cannot stop it, which is why shipped orders
go through the returns flow instead.
`,
    },
  ],
  files: [
    {
      path: 'src/main/java/com/acme/shop/order/OrderStatus.java',
      content: `
package com.acme.shop.order;

import java.util.EnumSet;
import java.util.Set;

public enum OrderStatus {
    PENDING,
    PAID,
    SHIPPED,
    DELIVERED,
    CANCELLED;

    /** Statuses from which an order may be cancelled. */
    public static final Set<OrderStatus> CANCELLABLE = EnumSet.of(PENDING, PAID, SHIPPED);

    /** The only forward step allowed from this status, or null for final statuses. */
    public OrderStatus next() {
        return switch (this) {
            case PENDING -> PAID;
            case PAID -> SHIPPED;
            case SHIPPED -> DELIVERED;
            case DELIVERED, CANCELLED -> null;
        };
    }
}
`,
    },
    {
      path: 'src/main/java/com/acme/shop/order/Order.java',
      diff: `
 package com.acme.shop.order;

 import java.time.Instant;

 public class Order {
     private final String id;
     private final String customerId;
     private final long capturedAmountMinor;
     private OrderStatus status;
     private Instant updatedAt;

     public Order(String id, String customerId, long capturedAmountMinor, OrderStatus status) {
         this.id = id;
         this.customerId = customerId;
         this.capturedAmountMinor = capturedAmountMinor;
         this.status = status;
     }

-    public void setStatus(OrderStatus status) {
-        this.status = status;
-        this.updatedAt = Instant.now();
-    }
+    /** Moves the order one step forward; anything but the next status is refused. */
+    public void transitionTo(OrderStatus target) {
+        if (status.next() != target) {
+            throw new IllegalStatusTransition(status, target);
+        }
+        this.status = target;
+        this.updatedAt = Instant.now();
+    }
+
+    /** Cancels the order if its current status allows it. */
+    public void cancel() {
+        if (!OrderStatus.CANCELLABLE.contains(status)) {
+            throw new IllegalStatusTransition(status, OrderStatus.CANCELLED);
+        }
+        this.status = OrderStatus.CANCELLED;
+        this.updatedAt = Instant.now();
+    }

     public String id() { return id; }
     public String customerId() { return customerId; }
     public long capturedAmountMinor() { return capturedAmountMinor; }
     public OrderStatus status() { return status; }
     public Instant updatedAt() { return updatedAt; }
 }
`,
    },
    {
      path: 'src/main/java/com/acme/shop/order/IllegalStatusTransition.java',
      content: `
package com.acme.shop.order;

public class IllegalStatusTransition extends RuntimeException {
    private final OrderStatus from;
    private final OrderStatus to;

    public IllegalStatusTransition(OrderStatus from, OrderStatus to) {
        super("cannot move order from " + from + " to " + to);
        this.from = from;
        this.to = to;
    }

    public OrderStatus from() { return from; }
    public OrderStatus to() { return to; }
}
`,
    },
    {
      path: 'src/main/java/com/acme/shop/order/OrderService.java',
      diff: `
 package com.acme.shop.order;

 import com.acme.shop.payment.PaymentGateway;

 public class OrderService {
     private final OrderRepository orders;
     private final PaymentGateway payments;

     public OrderService(OrderRepository orders, PaymentGateway payments) {
         this.orders = orders;
         this.payments = payments;
     }

-    public void markShipped(String orderId) {
+    public void markShipped(String orderId, String actorId) {
         Order order = orders.get(orderId);
-        order.setStatus(OrderStatus.SHIPPED);
+        order.transitionTo(OrderStatus.SHIPPED);
         orders.save(order);
     }
+
+    public Order cancel(String orderId, String actorId) {
+        Order order = orders.get(orderId);
+        OrderStatus before = order.status();
+        order.cancel();
+        if (before == OrderStatus.PAID) {
+            payments.refund(order.id(), order.capturedAmountMinor());
+        }
+        orders.save(order);
+        return order;
+    }
 }
`,
    },
    {
      path: 'src/main/java/com/acme/shop/order/OrderController.java',
      diff: `
 package com.acme.shop.order;

 import com.acme.shop.http.HttpException;
 import com.acme.shop.http.Request;
 import com.acme.shop.http.Response;

 public class OrderController {
     private final OrderService service;

     public OrderController(OrderService service) {
         this.service = service;
     }

     public Response ship(Request req) {
-        service.markShipped(req.pathParam("id"));
+        service.markShipped(req.pathParam("id"), req.userId());
         return Response.noContent();
     }
+
+    public Response cancel(Request req) {
+        try {
+            Order order = service.cancel(req.pathParam("id"), req.userId());
+            return Response.ok(order);
+        } catch (IllegalStatusTransition e) {
+            throw new HttpException(409, "order cannot be cancelled in status " + e.from());
+        }
+    }
 }
`,
    },
    {
      path: 'src/test/java/com/acme/shop/order/OrderServiceTest.java',
      content: `
package com.acme.shop.order;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.acme.shop.payment.PaymentGateway;
import org.junit.jupiter.api.Test;

class OrderServiceTest {
    private final OrderRepository orders = new InMemoryOrderRepository();
    private final PaymentGateway payments = mock(PaymentGateway.class);
    private final OrderService service = new OrderService(orders, payments);

    @Test
    void cancelsPaidOrderAndRefunds() {
        orders.save(new Order("o-1", "c-1", 4_990, OrderStatus.PAID));
        Order cancelled = service.cancel("o-1", "agent-7");
        assertEquals(OrderStatus.CANCELLED, cancelled.status());
        verify(payments).refund("o-1", 4_990);
    }
}
`,
    },
    {
      path: 'src/main/resources/application.yml',
      diff: `
 server:
   port: 8080
 orders:
   routes:
     ship: true
+    cancel: true
 payment:
-  client-version: 3.4.1
+  client-version: 3.5.0
`,
    },
    {
      path: 'gradle.lockfile',
      diff: `
 com.fasterxml.jackson.core:jackson-databind:2.17.1=compileClasspath,runtimeClasspath
-com.acme.payments:payment-client:3.4.1=compileClasspath,runtimeClasspath
+com.acme.payments:payment-client:3.5.0=compileClasspath,runtimeClasspath
 org.junit.jupiter:junit-jupiter:5.10.2=testCompileClasspath,testRuntimeClasspath
`,
    },
  ],
  expected: {
    expectedAlignment: 'misaligned',
    mustFindings: [
      {
        id: 'AC1',
        requirement: 'Only forward transitions along the status chain',
        labels: ['AC1'],
        keywords: ['IllegalStatusTransition', 'moves only along'],
        accept: ['covered'],
      },
      {
        id: 'AC2',
        requirement: 'Cancel only while PENDING or PAID; SHIPPED/DELIVERED get 409',
        labels: ['AC2'],
        keywords: ['HTTP 409', 'cancelled only while'],
        accept: ['contradicts'],
      },
      {
        id: 'AC3',
        requirement: 'Full refund when a PAID order is cancelled',
        labels: ['AC3'],
        keywords: ['full captured amount'],
        accept: ['covered'],
      },
      {
        id: 'AC4',
        requirement: 'Status history row per change',
        labels: ['AC4'],
        keywords: ['order_status_history'],
        accept: ['missing'],
      },
    ],
    mustScenarios: [
      {
        id: 'cancel-shipped',
        risk: 'Cancelling a SHIPPED order must return 409, but CANCELLABLE includes SHIPPED so it succeeds',
        keywords: [['shipped'], ['409', 'cancel']],
      },
      {
        id: 'cancel-delivered',
        risk: 'Cancelling a DELIVERED order is refused with 409',
        keywords: [['delivered'], ['409', 'reject', 'refuse', 'cannot', 'not allowed']],
      },
      {
        id: 'refund-paid-only',
        risk: 'Cancelling a PAID order refunds the full captured amount; cancelling a PENDING order calls no refund',
        keywords: [['refund'], ['pending', 'paid']],
      },
      {
        id: 'skip-transition',
        risk: 'Skipping a step (PENDING straight to SHIPPED) or going backwards is rejected with IllegalStatusTransition',
        keywords: [
          [
            'illegalstatustransition',
            'skip',
            'backward',
            'invalid transition',
            'pending to shipped',
            'pending → shipped',
          ],
        ],
      },
      {
        id: 'history',
        risk: 'Each status change writes an order_status_history row with previous status, new status and actor id',
        keywords: [['history', 'audit']],
      },
      {
        id: 'refund-failure',
        risk: 'The gateway refund fails while cancelling a PAID order: the order must not end up CANCELLED without a refund',
        keywords: [['refund'], ['fail', 'error', 'timeout', 'exception']],
      },
    ],
    forbidden: [
      {
        id: 'invented-features',
        description: 'Partial refunds and store credit appear in neither the ticket nor the code',
        patterns: ['store credit', 'partial refund'],
        fields: ['scenarios', 'findings'],
      },
    ],
    tags: ['orders', 'java', 'state-machine', 'noise', 'contradicts', 'missing'],
    notes:
      'AC2 is contradicted (OrderStatus.CANCELLABLE includes SHIPPED) and AC4 (status history table) has no code at all. Test, config and lockfile changes are noise.',
  },
};
