// 予約のルール（空き判定、料金、キャンセル料、日時の判定）。入出力を持たない純粋な関数だけを置く（INV-5）
export { checkTimeUnitAndDuration } from "./time-unit-and-duration.ts";
export type { TimeUnitCheckResult, TimeUnitRejectionReason } from "./time-unit-and-duration.ts";
export { provisionalDeadline } from "./provisional-deadline.ts";
export { checkApplicationDeadline } from "./application-deadline.ts";
export type {
  ApplicationDeadlineInput,
  ApplicationDeadlineResult,
  ApplicationDeadlineViolation,
  ApplicationKind,
} from "./application-deadline.ts";
export { calculatePriceFromTable, decidePlanId } from "./price-table-pricing.ts";
export type {
  PlanDecisionInput,
  PriceTableQuote,
  PriceTableQuoteInput,
} from "./price-table-pricing.ts";
export { currentPriceTable } from "./current-price-table.ts";
export { calculateCancellationFee } from "./cancellation-fee.ts";
export type {
  CancellableStatus,
  CancellationFee,
  CancellationFeeInput,
  CancellationFeeRatePercent,
} from "./cancellation-fee.ts";
export { checkAvailability, checkBufferChange, occupiedRange } from "./availability.ts";
export type {
  AvailabilityInput,
  AvailabilityResult,
  BufferChangeInput,
  BufferChangeResult,
  BufferMinutes,
  ExistingBlock,
  ExistingReservation,
  ReservationBufferMinutes,
  TimeRange,
} from "./availability.ts";
export { checkSecondHoldApplicationDeadline } from "./second-hold-application-deadline.ts";
export type {
  SecondHoldApplicationDeadlineInput,
  SecondHoldApplicationDeadlineResult,
} from "./second-hold-application-deadline.ts";
export { checkSecondHoldApplication } from "./second-hold.ts";
export type {
  SecondHoldApplication,
  SecondHoldApplicationResult,
  SecondHoldRejection,
} from "./second-hold.ts";
export {
  applyReservationOperation,
  needsProvisionalDeadlineWarning,
} from "./reservation-transitions.ts";
export type {
  Reservation,
  ReservationDraft,
  ReservationOperation,
  ReservationOperationRejection,
  ReservationOperationResult,
} from "./reservation-transitions.ts";
export { approveReservation, rejectReservation } from "./reservation-approval.ts";
export type {
  ApprovalDraft,
  ApprovalFailureReason,
  ApprovalResult,
  RejectionDraft,
  RejectionResult,
} from "./reservation-approval.ts";
export { applyReservationChange } from "./reservation-change.ts";
export type {
  ReservationChange,
  ReservationChangeContent,
  ReservationChangeDraft,
  ReservationChangeEstimate,
  ReservationChangeFailureReason,
  ReservationChangeResult,
} from "./reservation-change.ts";
