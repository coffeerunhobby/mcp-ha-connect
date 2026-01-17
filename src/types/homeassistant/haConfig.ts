export interface HaConfig {
  baseUrl: string;
  token: string;
  strictSsl: boolean;
  timeout: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
