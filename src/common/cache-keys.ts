export const CacheKeys = {
  userSession: (userId: string) => `user_session:${userId}`,
  otpAttempts: (email: string) => `otp_attempts:${email}`,
};
