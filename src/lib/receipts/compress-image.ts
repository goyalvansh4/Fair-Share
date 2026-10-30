const MAX_SIDE = 1600;

export type PreparedImage = { data: string; media_type: 'image/jpeg' };

/**
 * Shrinks a phone photo to at most 1600px on the long side as a JPEG, then returns it as base64 (no data: prefix).
 * Phone photos are often 5-10 MB; the receipt stays perfectly legible at this size and uploads in a second.
 */
export async function prepareReceiptImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image format is not supported. Try a JPEG or PNG photo.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser cannot process images.');
  context.fillStyle = '#ffffff'; // transparent PNGs would otherwise turn black as JPEG
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Could not prepare the photo.');
  if (blob.size > 4_000_000) throw new Error('The photo is too large. Try a smaller picture.');

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { data: btoa(binary), media_type: 'image/jpeg' };
}
