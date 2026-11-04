/**
 * `accept` lists for file pickers, mirroring what each server route takes.
 *
 * "image/*" let people pick .heif, .bmp or .tiff, which the server then
 * refused — failing the whole Mark Paid / refund / request after everything
 * else was filled in. Keep these in step with the backend filters named below.
 */

/** Payment, refund, cancel and customs-duty receipts (indents.controller receiptFileFilter). */
export const RECEIPT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.heic';

/** Request / indent / feedback attachments (requests, indents and feedback controllers). */
export const PHOTO_VIDEO_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.heic,.mp4,.mov,.webm,.mkv';

/** Asset photos (fixed-assets.service ALLOWED_PHOTO_MIMES). */
export const ASSET_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif';

/** Spreadsheet imports (inventory.controller bulk upload: csv / xlsx / xls). */
export const SHEET_ACCEPT = '.csv,.xlsx,.xls';

/** Restore from download (inventory.controller RESTORE_UPLOAD: the .xlsx the Download button makes). */
export const RESTORE_ACCEPT = '.xlsx';
