export type Config = {
  awsRegion: string;
  sqsQueueUrl: string;
  s3Bucket: string;
  authPassword: string;
  apiToken: string;
  dbPath: string;
  fromDomain: string;
  baseUrl: string;
  sesConfigSet: string;
};

export function loadConfig(): Config {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`${key} is required`);
    return val;
  };

  return {
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    sqsQueueUrl: required("SQS_QUEUE_URL"),
    s3Bucket: required("S3_BUCKET"),
    authPassword: required("AUTH_PASSWORD"),
    apiToken: required("API_TOKEN"),
    dbPath: process.env.DB_PATH ?? "lists.db",
    fromDomain: process.env.FROM_DOMAIN ?? "jackharrhy.dev",
    baseUrl: required("BASE_URL"),
    sesConfigSet: process.env.SES_CONFIG_SET ?? "",
  };
}
