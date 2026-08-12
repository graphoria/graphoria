export type UserRecord = {
  username: string;
  password: string;
  role: string;
  is_active: boolean;
  claims: unknown; // JSON string or driver-parsed object
};
