import { z } from 'zod';

/** Minimum 12 characters, per the password policy in docs/security/controls.md. */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value), {
    message: 'Password must contain lower case, upper case and a digit',
  });

export const RegisterSchema = z
  .object({
    email: z.string().email().toLowerCase().trim(),
    password: PasswordSchema,
    firstName: z.string().min(1).max(80).trim(),
    lastName: z.string().min(1).max(80).trim(),
    organizationName: z.string().min(2).max(120).trim(),
    timezone: z.string().default('UTC'),
    locale: z.string().default('en'),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: z.string().email().toLowerCase().trim(),
    password: z.string().min(1),
    mfaCode: z.string().min(6).max(10).optional(),
    organizationId: z.string().optional(),
  })
  .strict();

export const RefreshSchema = z.object({ refreshToken: z.string().min(10) }).strict();

export const ForgotPasswordSchema = z
  .object({ email: z.string().email().toLowerCase().trim() })
  .strict();

export const ResetPasswordSchema = z
  .object({ token: z.string().min(10), password: PasswordSchema })
  .strict();

export const VerifyEmailSchema = z.object({ token: z.string().min(10) }).strict();

export const ChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: PasswordSchema })
  .strict();

export const EnableMfaSchema = z.object({ code: z.string().length(6) }).strict();

export const AcceptInviteSchema = z
  .object({
    token: z.string().min(10),
    password: PasswordSchema,
    firstName: z.string().min(1).max(80).trim(),
    lastName: z.string().min(1).max(80).trim(),
  })
  .strict();

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
