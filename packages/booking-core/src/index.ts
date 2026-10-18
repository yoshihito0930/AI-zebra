// 予約のルール（空き判定、料金、キャンセル料、日時の判定）。入出力を持たない純粋な関数だけを置く（INV-5）
export { checkTimeUnitAndDuration } from "./time-unit-and-duration";
export type { TimeUnitCheckResult, TimeUnitRejectionReason } from "./time-unit-and-duration";
export { provisionalDeadline } from "./provisional-deadline";
export { checkApplicationDeadline } from "./application-deadline";
export type {
  ApplicationDeadlineInput,
  ApplicationDeadlineResult,
  ApplicationDeadlineViolation,
  ApplicationKind,
} from "./application-deadline";
export { calculatePriceFromTable, decidePlanId } from "./price-table-pricing";
export type {
  PlanDecisionInput,
  PriceTableQuote,
  PriceTableQuoteInput,
} from "./price-table-pricing";
export { currentPriceTable } from "./current-price-table";
export { calculateCancellationFee } from "./cancellation-fee";
export type {
  CancellableStatus,
  CancellationFee,
  CancellationFeeInput,
  CancellationFeeRatePercent,
} from "./cancellation-fee";
export { checkAvailability, checkBufferChange, occupiedRange } from "./availability";
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
} from "./availability";
export { checkSecondHoldApplication } from "./second-hold";
export type {
  SecondHoldApplication,
  SecondHoldApplicationResult,
  SecondHoldRejection,
} from "./second-hold";
export {
  applyReservationOperation,
  needsProvisionalDeadlineWarning,
} from "./reservation-transitions";
export type {
  Reservation,
  ReservationDraft,
  ReservationOperation,
  ReservationOperationRejection,
  ReservationOperationResult,
} from "./reservation-transitions";
export { approveReservation, rejectReservation } from "./reservation-approval";
export type {
  ApprovalDraft,
  ApprovalFailureReason,
  ApprovalResult,
  RejectionDraft,
  RejectionResult,
} from "./reservation-approval";
export { applyReservationChange } from "./reservation-change";
export type {
  ReservationChange,
  ReservationChangeContent,
  ReservationChangeDraft,
  ReservationChangeEstimate,
  ReservationChangeFailureReason,
  ReservationChangeResult,
} from "./reservation-change";
