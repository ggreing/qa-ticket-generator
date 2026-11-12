/** Every authored eval case, in id order. Add a case here after writing its file. */

import { apiRateLimitAligned } from './api-rate-limit-aligned';
import { bookingHoldAligned } from './booking-hold-aligned';
import type { AuthoredCase } from './build';
import { catalogSyncMapreduce } from './catalog-sync-mapreduce';
import { contactImportJs } from './contact-import-js';
import { couponExpiryMissing } from './coupon-expiry-missing';
import { featureRolloutNoise } from './feature-rollout-noise';
import { ledgerExportNarrativeGo } from './ledger-export-narrative-go';
import { loginThrottleNoPrd } from './login-throttle-no-prd';
import { loyaltyPointsInjection } from './loyalty-points-injection';
import { migrationSplitName } from './migration-split-name';
import { noticeScheduleKoNarrative } from './notice-schedule-ko-narrative';
import { notificationRetryAligned } from './notification-retry-aligned';
import { orderCancelStateJava } from './order-cancel-state-java';
import { payrollRulesMapreduce } from './payroll-rules-mapreduce';
import { planProrationAligned } from './plan-proration-aligned';
import { profileInjection } from './profile-injection';
import { rbacExportRole } from './rbac-export-role';
import { refundWebhookKoPy } from './refund-webhook-ko-py';
import { reportTimezone } from './report-timezone';
import { searchPageCap } from './search-page-cap';
import { seatPickerAligned } from './seat-picker-aligned';
import { sessionExpiryKoTs } from './session-expiry-ko-ts';
import { stockReserveGo } from './stock-reserve-go';
import { uploadSizeScan } from './upload-size-scan';
import { webhookDeliveryNoPrd } from './webhook-delivery-no-prd';

export const CASES: AuthoredCase[] = [
  apiRateLimitAligned,
  bookingHoldAligned,
  catalogSyncMapreduce,
  contactImportJs,
  couponExpiryMissing,
  featureRolloutNoise,
  ledgerExportNarrativeGo,
  loginThrottleNoPrd,
  loyaltyPointsInjection,
  migrationSplitName,
  noticeScheduleKoNarrative,
  notificationRetryAligned,
  orderCancelStateJava,
  payrollRulesMapreduce,
  planProrationAligned,
  profileInjection,
  rbacExportRole,
  refundWebhookKoPy,
  reportTimezone,
  searchPageCap,
  seatPickerAligned,
  sessionExpiryKoTs,
  stockReserveGo,
  uploadSizeScan,
  webhookDeliveryNoPrd,
];
