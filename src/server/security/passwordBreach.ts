import crypto from 'node:crypto';

/**
 * Local fallback list of commonly breached/weak passwords in case HIBP API is unreachable (Rule 19).
 */
const LOCAL_COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  '123456789012',
  '1234567890ab',
  'qwertyuiop12',
  'qwerty123456',
  'admin1234567',
  'dental123456',
  'stomatolog12',
  'kazakhstan12',
  'almaty123456',
  'astana123456',
  'welcome12345',
  'letmein12345',
  'iloveyou1234',
]);

export interface PasswordValidationResult {
  valid: boolean;
  reasonCode?:
    | 'TOO_SHORT'
    | 'CONTAINS_CONTEXT'
    | 'TRIVIAL_PATTERN'
    | 'BREACHED_PASSWORD';
  breachCount?: number;
}

/**
 * Validates password strength and checks Have I Been Pwned "Pwned Passwords" range API
 * using k-anonymity (only the first 5 hex characters of SHA-1 leave the server) (Rule 9 & Rule 19).
 */
export async function validatePasswordSecurity(
  password: string,
  context: { email?: string; clinicName?: string } = {}
): Promise<PasswordValidationResult> {
  if (!password || password.length < 12) {
    return { valid: false, reasonCode: 'TOO_SHORT' };
  }

  const lower = password.toLowerCase();

  // Reject passwords containing clinic name or email local-part (Rule 19)
  if (context.email) {
    const emailUser = context.email.split('@')[0]?.toLowerCase();
    if (emailUser && emailUser.length >= 3 && lower.includes(emailUser)) {
      return { valid: false, reasonCode: 'CONTAINS_CONTEXT' };
    }
  }
  if (context.clinicName) {
    const cleanClinic = context.clinicName.toLowerCase().replace(/\s+/g, '');
    if (cleanClinic.length >= 3 && lower.replace(/\s+/g, '').includes(cleanClinic)) {
      return { valid: false, reasonCode: 'CONTAINS_CONTEXT' };
    }
  }

  // Reject trivial repeating characters or local common passwords
  if (/^(.)\1+$/.test(password) || LOCAL_COMMON_PASSWORDS.has(lower)) {
    return { valid: false, reasonCode: 'TRIVIAL_PATTERN' };
  }

  // Compute SHA-1 hash for k-anonymity range lookup
  const sha1Full = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix5 = sha1Full.slice(0, 5);
  const suffix35 = sha1Full.slice(5);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix5}`, {
      headers: {
        'User-Agent': 'Digital-Dental-Notebook-Security-Check',
        'Add-Padding': 'true',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const body = await res.text();
      for (const line of body.split(/\r?\n/)) {
        const [hashSuffix, countStr] = line.trim().split(':');
        if (hashSuffix === suffix35) {
          const count = parseInt(countStr || '0', 10);
          if (count > 0) {
            return {
              valid: false,
              reasonCode: 'BREACHED_PASSWORD',
              breachCount: count,
            };
          }
        }
      }
    }
  } catch {
    // Graceful fallback if offline or HIBP timeout (Rule 19: do not lock users out on API downtime)
  }

  return { valid: true };
}
