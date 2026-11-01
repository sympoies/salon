/**
 * Put the image on the system clipboard as PNG, the one image type every
 * clipboard accepts. WebKit rejects a clipboard write that starts after an
 * await, so the write begins at once and a converted image travels as a
 * pending item value.
 */
export function copyConversationImage(blob: Blob): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === "undefined") return Promise.reject(new Error("Image copy unavailable"));
  const png = blob.type === "image/png" ? blob : convertToPng(blob);
  return clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function convertToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Image conversion failed")), "image/png"));
  } finally {
    bitmap.close();
  }
}
