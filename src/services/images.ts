import sharp from "sharp";

export type ProcessedImage = {
  data: Buffer;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  dataUri: string;
};

export async function processImage(input: Buffer | ArrayBuffer): Promise<ProcessedImage> {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const image = sharp(buf)
    .resize({ width: 600, withoutEnlargement: true })
    .webp({ quality: 80 });

  const data = await image.toBuffer();
  const metadata = await sharp(data).metadata();

  const dataUri = `data:image/webp;base64,${data.toString("base64")}`;

  return {
    data,
    mimeType: "image/webp",
    sizeBytes: data.length,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    dataUri,
  };
}
