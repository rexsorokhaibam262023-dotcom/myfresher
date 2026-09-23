import React, { useState, useEffect } from 'react';
import { UserPassPortal } from './components/UserPassPortal';
import { AdminPortal } from './components/AdminPortal';

export default function App() {
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() => {
    const path = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    return path.startsWith('/admin') || hash.startsWith('#admin') || hash.includes('admin');
  });

  const [ticketToken, setTicketToken] = useState<string | undefined>(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#ticket_')) {
      return hash.replace('#ticket_', '');
    }
    const params = new URLSearchParams(window.location.search);
    return params.get('ticket') || params.get('token') || undefined;
  });

  useEffect(() => {
    const handleLocationChange = () => {
      const path = window.location.pathname.toLowerCase();
      const hash = window.location.hash.toLowerCase();
      const isAdmin = path.startsWith('/admin') || hash.startsWith('#admin') || hash.includes('admin');
      setIsAdminRoute(isAdmin);

      if (window.location.hash.startsWith('#ticket_')) {
        setTicketToken(window.location.hash.replace('#ticket_', ''));
      }
    };

    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);

    // Keyboard shortcut (Ctrl+Shift+A) for gate admins
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        if (isAdminRoute) {
          window.location.hash = '';
          window.history.pushState(null, '', '/');
          setIsAdminRoute(false);
        } else {
          window.location.hash = '#admin';
          setIsAdminRoute(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAdminRoute]);

  if (isAdminRoute) {
    return <AdminPortal />;
  }

  return <UserPassPortal initialAccessToken={ticketToken} />;
}
