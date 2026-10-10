/** Proteção de identidade de plataforma, independente do papel na organização. */
export function isProtectedUser(
  user: { email: string; isPlatformMaster: boolean },
  configuredEmail: string | undefined = process.env.SCOUT_BOOTSTRAP_ADMIN_EMAIL,
): boolean {
  const principalEmail = configuredEmail?.trim().toLowerCase();
  return (
    user.isPlatformMaster ||
    Boolean(principalEmail && user.email.toLowerCase() === principalEmail)
  );
}
