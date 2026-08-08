'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Creation now happens inline from the forms list ("+ New form"), which names
// the form and navigates straight into the single-screen builder. This old
// route just redirects there.
export default function NewConsentFormRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/consent/forms');
  }, [router]);
  return null;
}
