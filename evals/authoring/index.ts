/** Every authored eval case, in id order. Add a case here after writing its file. */
import { bookingHoldAligned } from './booking-hold-aligned';
import type { AuthoredCase } from './build';
import { couponExpiryMissing } from './coupon-expiry-missing';
import { loginThrottleNoPrd } from './login-throttle-no-prd';
import { migrationSplitName } from './migration-split-name';
import { notificationRetryAligned } from './notification-retry-aligned';
import { profileInjection } from './profile-injection';
import { rbacExportRole } from './rbac-export-role';
import { reportTimezone } from './report-timezone';
import { searchPageCap } from './search-page-cap';
import { uploadSizeScan } from './upload-size-scan';

export const CASES: AuthoredCase[] = [
  bookingHoldAligned,
  couponExpiryMissing,
  loginThrottleNoPrd,
  migrationSplitName,
  notificationRetryAligned,
  profileInjection,
  rbacExportRole,
  reportTimezone,
  searchPageCap,
  uploadSizeScan,
];
