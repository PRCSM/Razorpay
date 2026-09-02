import { handlers } from '@/auth';

/** Auth.js route handlers. Node runtime: the credentials provider needs bcrypt. */
export const runtime = 'nodejs';

export const { GET, POST } = handlers;
