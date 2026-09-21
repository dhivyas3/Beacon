-- A delivery that was deliberately not sent, for example to a recipient who only wants reports
-- with new issues when there are none.
ALTER TYPE "DeliveryStatus" ADD VALUE 'skipped';
