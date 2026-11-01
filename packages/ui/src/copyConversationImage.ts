/** Put the image on the system clipboard as PNG, the one image type every clipboard accepts. */
export async function copyConversationImage(blob: Blob): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image copy unavailable");
  const png = blob.type === "image/png" ? blob : await convertToPng(blob);
  await clipboard.write([new ClipboardItem({ "image/png": png })]);
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
