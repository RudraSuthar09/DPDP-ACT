'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '../lib/api';

/** Entry point: send authenticated users to the app, everyone else to sign-in. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/audit' : '/login');
  }, [router]);
  return (
    <p style={{ padding: 24 }} className="muted">
      Loading…
    </p>
  );
}
