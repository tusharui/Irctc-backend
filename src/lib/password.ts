

const ALGORITHM = "argon2id" as const;

const MEMORY_COST = 19456;


const TIME_COST = 2;


export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, {
    algorithm: ALGORITHM,
    memoryCost: MEMORY_COST,
    timeCost: TIME_COST,
  });
}


export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}
