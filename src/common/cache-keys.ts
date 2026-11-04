export const CacheKeys = {
  userSession: (userId: string) => `user_session:${userId}`,
  handyChatRate: (userId: string) => `handy_chat:${userId}`,
  handyPlan: (userId: string, planId: string) =>
    `handy_plan:${userId}:${planId}`,
  otpAttempts: (email: string) => `otp_attempts:${email}`,
};
