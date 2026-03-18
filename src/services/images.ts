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

export function extractPendingS3Images(markdown: string): Array<{ uuid: string; alt: string; dataUri: string; marker: string }> {
  const regex = /<!-- s3-pending:([a-f0-9-]+) -->!\[([^\]]*)\]\((data:image\/webp;base64,[^)]+)\)/g;
  const results = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    results.push({
      uuid: match[1],
      alt: match[2],
      dataUri: match[3],
      marker: match[0],
    });
  }
  return results;
}

export async function processPendingS3Images(
  markdown: string,
  campaignId: number,
  config: { s3MediaBucket: string; s3MediaBaseUrl: string; awsRegion: string },
): Promise<string> {
  if (!config.s3MediaBucket) return markdown;

  const pending = extractPendingS3Images(markdown);
  if (pending.length === 0) return markdown;

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: config.awsRegion });
  const baseUrl = config.s3MediaBaseUrl || `https://${config.s3MediaBucket}.s3.${config.awsRegion}.amazonaws.com`;

  let result = markdown;
  for (const item of pending) {
    const key = `images/${campaignId}/${item.uuid}.webp`;
    // decode base64 dataUri
    const base64 = item.dataUri.replace("data:image/webp;base64,", "");
    const buf = Buffer.from(base64, "base64");

    await s3.send(new PutObjectCommand({
      Bucket: config.s3MediaBucket,
      Key: key,
      Body: buf,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000",
    }));

    const url = `${baseUrl}/${key}`;
    // Replace the full marker+dataUri with the S3 URL
    result = result.replace(item.marker, `![image](${url})`);
  }

  return result;
}

export async function deleteCampaignS3Images(
  campaignId: number,
  config: { s3MediaBucket: string; awsRegion: string },
): Promise<void> {
  if (!config.s3MediaBucket) return;

  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: config.awsRegion });
  const prefix = `images/${campaignId}/`;

  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: config.s3MediaBucket,
    Prefix: prefix,
  }));

  if (!listed.Contents || listed.Contents.length === 0) return;

  await s3.send(new DeleteObjectsCommand({
    Bucket: config.s3MediaBucket,
    Delete: {
      Objects: listed.Contents.map((obj) => ({ Key: obj.Key! })),
    },
  }));

  console.log(`Deleted ${listed.Contents.length} S3 objects for campaign ${campaignId}`);
}
