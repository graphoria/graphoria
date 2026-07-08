export const hashPassword = (password: string) => Bun.password.hash(password);

export const verifyPassword = async (plain: string, hashed: string) =>
  Bun.password.verify(plain, hashed);
