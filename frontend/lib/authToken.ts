// Token di sessione in memoria, condiviso tra api.ts e auth.tsx senza creare
// un ciclo di import. auth.tsx lo setta dopo il login; api.ts lo legge per
// aggiungere l'header Authorization: Bearer.
let _token: string | null = null;

export function getAuthToken(): string | null {
  return _token;
}

export function setAuthTokenMem(t: string | null): void {
  _token = t;
}
