import React, { useState, useEffect, useRef } from 'react';
import { Attendee, DashboardStats, VerifyQrResponse, AdminUser, EventSettings } from '../types';
import { MasterTicketCanvas } from './MasterTicketCanvas';

export const AdminPortal: React.FC = () => {
  // Authentication State
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('msap_admin_token'));
  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  // Login Form State
  const [loginEmail, setLoginEmail] = useState('admin@msap.org');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Navigation State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'attendees' | 'scanner'>('dashboard');

  // Dashboard Stats State
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);

  // Event Settings State
  const [eventSettings, setEventSettings] = useState<EventSettings | null>(null);
  const [eventTimeInput, setEventTimeInput] = useState('');
  const [eventVenueInput, setEventVenueInput] = useState('');
  const [eventPriceInput, setEventPriceInput] = useState('');
  const [eventSettingsLoading, setEventSettingsLoading] = useState<boolean>(false);
  const [eventSettingsSaving, setEventSettingsSaving] = useState<boolean>(false);
  const [eventSettingsMessage, setEventSettingsMessage] = useState<string | null>(null);

  // Attendees State
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeesTotal, setAttendeesTotal] = useState<number>(0);
  const [attendeesLoading, setAttendeesLoading] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [paymentFilter, setPaymentFilter] = useState<string>('ALL');
  const [checkInFilter, setCheckInFilter] = useState<string>('ALL');
  const [selectedAttendee, setSelectedAttendee] = useState<Attendee | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // QR Scanner State
  const [scannerTokenInput, setScannerTokenInput] = useState<string>('');
  const [scanResult, setScanResult] = useState<VerifyQrResponse | null>(null);
  const [scanLoading, setScanLoading] = useState<boolean>(false);
  const [checkInLoading, setCheckInLoading] = useState<boolean>(false);
  const [checkInSuccessMsg, setCheckInSuccessMsg] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ----------------------------------------------------
  // Auth Verification on Mount
  // ----------------------------------------------------
  useEffect(() => {
    if (token) {
      verifyToken(token);
    } else {
      setAuthLoading(false);
    }
  }, [token]);

  const verifyToken = async (jwtToken: string) => {
    try {
      setAuthLoading(true);
      const res = await fetch('/api/admin/me', {
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAdminUser(data.admin);
        fetchDashboardStats(jwtToken);
        fetchEventSettings(jwtToken);
      } else {
        // Expired or invalid token
        handleLogout();
      }
    } catch {
      handleLogout();
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
      });
      const data = await res.json();

      if (res.ok && data.token) {
        localStorage.setItem('msap_admin_token', data.token);
        setToken(data.token);
        setAdminUser(data.admin);
        fetchDashboardStats(data.token);
        fetchEventSettings(data.token);
      } else {
        setLoginError(data.error || 'Authentication failed.');
      }
    } catch {
      setLoginError('Could not reach backend authentication service.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('msap_admin_token');
    setToken(null);
    setAdminUser(null);
    stopCamera();
  };

  // ----------------------------------------------------
  // Dashboard Metrics
  // ----------------------------------------------------
  const fetchDashboardStats = async (jwt = token) => {
    if (!jwt) return;
    setStatsLoading(true);
    try {
      const res = await fetch('/api/admin/dashboard', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats);
      }
    } catch (err) {
      console.error('Stats fetch error:', err);
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchEventSettings = async (jwt = token) => {
    if (!jwt) return;
    setEventSettingsLoading(true);
    try {
      const res = await fetch('/api/admin/event-settings', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        setEventSettings(data.settings);
        setEventTimeInput(data.settings.time);
        setEventVenueInput(data.settings.venue);
        setEventPriceInput(String(data.settings.registrationPrice));
      } else {
        setEventSettingsMessage(`❌ ${data.error || 'Failed to load event settings.'}`);
      }
    } catch {
      setEventSettingsMessage('❌ Network error loading event settings.');
    } finally {
      setEventSettingsLoading(false);
    }
  };

  const handleSaveEventSettings = async () => {
    if (!token) return;
    const time = eventTimeInput.trim();
    const venue = eventVenueInput.trim();
    const price = Number(eventPriceInput);

    if (!time || !venue || !Number.isFinite(price) || price <= 0) {
      setEventSettingsMessage('❌ Enter a valid time, venue, and registration price greater than ₹0.');
      return;
    }

    setEventSettingsSaving(true);
    setEventSettingsMessage(null);
    try {
      const res = await fetch('/api/admin/event-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ time, venue, registrationPrice: price }),
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        setEventSettings(data.settings);
        setEventTimeInput(data.settings.time);
        setEventVenueInput(data.settings.venue);
        setEventPriceInput(String(data.settings.registrationPrice));
        setEventSettingsMessage('✅ Event time, venue, and registration price updated successfully.');
      } else {
        setEventSettingsMessage(`❌ ${data.error || 'Failed to update event settings.'}`);
      }
    } catch {
      setEventSettingsMessage('❌ Network error updating event settings. No changes were applied.');
    } finally {
      setEventSettingsSaving(false);
    }
  };

  // ----------------------------------------------------
  // Attendee Management
  // ----------------------------------------------------
  const fetchAttendeesList = async (jwt = token) => {
    if (!jwt) return;
    setAttendeesLoading(true);
    try {
      const queryParams = new URLSearchParams();
      if (searchTerm) queryParams.set('search', searchTerm);
      if (categoryFilter !== 'ALL') queryParams.set('category', categoryFilter);
      if (paymentFilter !== 'ALL') queryParams.set('payment_status', paymentFilter);
      if (checkInFilter !== 'ALL') queryParams.set('check_in_status', checkInFilter);
      queryParams.set('limit', '200');

      const res = await fetch(`/api/admin/attendees?${queryParams.toString()}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (res.ok) {
        const data = await res.json();
        setAttendees(data.attendees || []);
        setAttendeesTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Attendees fetch error:', err);
    } finally {
      setAttendeesLoading(false);
    }
  };

  useEffect(() => {
    if (token && activeTab === 'attendees') {
      fetchAttendeesList();
    }
  }, [token, activeTab, searchTerm, categoryFilter, paymentFilter, checkInFilter]);

  // Verify Student Payment and Generate Ticket
  const handleVerifyPayment = async (attendeeId: number) => {
    if (!token) return;
    setActionMessage(null);

    const confirmed = window.confirm(
      'Verify this payment and generate an official Master Entry Ticket for this student?'
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/admin/attendees/${attendeeId}/verify-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (res.ok && data.attendee) {
        setActionMessage(`✅ ${data.message}`);
        setSelectedAttendee(data.attendee);
        fetchAttendeesList();
        fetchDashboardStats();
      } else {
        setActionMessage(`❌ ${data.error || 'Failed to verify payment.'}`);
      }
    } catch {
      setActionMessage('❌ Network error verifying payment.');
    }
  };

  // Reject Student Payment
  const handleRejectPayment = async (attendeeId: number) => {
    if (!token) return;
    setActionMessage(null);

    const reason = window.prompt(
      'Enter reason for rejecting this payment (student will be asked to re-enter a valid UTR):',
      'UTR not found in bank statement'
    );
    if (reason === null) return; // User cancelled prompt
    const cleanReason = reason.trim() || 'Payment reference could not be verified';

    try {
      const res = await fetch(`/api/admin/attendees/${attendeeId}/reject-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: cleanReason }),
      });
      const data = await res.json();
      if (res.ok && data.attendee) {
        setActionMessage(`⚠️ ${data.message}`);
        setSelectedAttendee(data.attendee);
        fetchAttendeesList();
        fetchDashboardStats();
      } else {
        setActionMessage(`❌ ${data.error || 'Failed to reject payment.'}`);
      }
    } catch {
      setActionMessage('❌ Network error rejecting payment.');
    }
  };

  // Emergency Admin Manual Payment Override (Audited)
  const handleConfirmPayment = async (attendeeId: number) => {
    if (!token) return;
    setActionMessage(null);

    const reason = window.prompt(
      'EMERGENCY ADMIN OVERRIDE:\nAutomatic gateway verification is the primary method.\nEnter the mandatory audit justification / bank UTR reference for manual confirmation (min 5 characters):',
      ''
    );

    if (!reason || reason.trim().length < 5) {
      alert('Manual override aborted: A mandatory audit justification of at least 5 characters is required.');
      return;
    }

    try {
      const res = await fetch(`/api/admin/attendees/${attendeeId}/confirm-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionMessage(`✅ ${data.message}`);
        // Refresh local attendee in modal and list
        const adminEmail = adminUser?.email || 'admin@msap.org';
        setSelectedAttendee((prev) => (prev ? { ...prev, payment_status: 'PAID', payment_confirmed_by: `MANUAL_OVERRIDE_BY_${adminEmail} (Reason: ${reason.trim()})` } : null));
        fetchAttendeesList();
        fetchDashboardStats();
      } else {
        setActionMessage(`❌ ${data.error || 'Failed to confirm payment.'}`);
      }
    } catch {
      setActionMessage('❌ Network error confirming payment.');
    }
  };

  // Admin Refund & Pass Revocation
  const handleRefundPayment = async (attendeeId: number) => {
    if (!token) return;
    const reason = window.prompt(
      'REFUND PAYMENT & REVOKE ENTRY PASS:\nProvide a reason for refunding this payment and revoking the admission pass:',
      ''
    );
    if (!reason || reason.trim().length < 5) {
      alert('Refund aborted: A reason (minimum 5 characters) is mandatory.');
      return;
    }

    try {
      const res = await fetch(`/api/admin/attendees/${attendeeId}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionMessage(`⚠️ ${data.message}`);
        setSelectedAttendee((prev) =>
          prev ? { ...prev, payment_status: 'REFUNDED', entry_pass_status: 'REVOKED' } : null
        );
        fetchAttendeesList();
        fetchDashboardStats();
      } else {
        setActionMessage(`❌ ${data.error || 'Failed to refund payment.'}`);
      }
    } catch {
      setActionMessage('❌ Network error issuing refund.');
    }
  };

  // ----------------------------------------------------
  // QR Scanner & Verification
  // ----------------------------------------------------
  const handleVerifyQr = async (qrTokenToVerify: string) => {
    if (!token || !qrTokenToVerify.trim()) return;
    setScanLoading(true);
    setScanResult(null);
    setCheckInSuccessMsg(null);

    try {
      const res = await fetch('/api/admin/verify-qr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ qr_token: qrTokenToVerify.trim() }),
      });
      const data = await res.json();
      setScanResult(data);
    } catch {
      setScanResult({
        status: 'INVALID',
        message: 'Network verification failure. Check server connectivity.',
      });
    } finally {
      setScanLoading(false);
    }
  };

  // Confirm Entry Admittance
  const handleConfirmEntry = async (attendeeId: number) => {
    if (!token) return;
    setCheckInLoading(true);
    try {
      const res = await fetch('/api/admin/check-in', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ attendee_id: attendeeId }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        setCheckInSuccessMsg(`🎉 ENTRY ADMITTED: ${data.attendee.full_name} (${data.attendee.ticket_id})!`);
        // Update current scanResult
        if (scanResult && scanResult.attendee) {
          setScanResult({
            ...scanResult,
            status: 'ALREADY_CHECKED_IN',
            message: 'Attendee successfully checked in.',
            attendee: {
              ...scanResult.attendee,
              check_in_status: 'CHECKED_IN',
              check_in_time: data.attendee.check_in_time,
            },
          });
        }
        fetchDashboardStats();
      } else {
        alert(data.error || 'Check-in transaction rejected.');
      }
    } catch {
      alert('Check-in communication error.');
    } finally {
      setCheckInLoading(false);
    }
  };

  // Camera Management
  const startCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
    } catch (err: unknown) {
      console.warn('Camera error:', err);
      setCameraError('Camera access unavailable. Use manual QR token or barcode input below.');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // ----------------------------------------------------
  // UN-AUTHENTICATED STATE: ACCESS DENIED LOGIN SCREEN
  // ----------------------------------------------------
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#061A2E] text-[#EAF6FF] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="material-symbols-outlined text-[#38BDF8] text-4xl animate-spin">progress_activity</span>
          <span className="font-mono-code text-sm text-[#9DB8CF]">Validating Administrative Session...</span>
        </div>
      </div>
    );
  }

  if (!token || !adminUser) {
    return (
      <div className="min-h-screen bg-[#061A2E] text-[#EAF6FF] flex items-center justify-center p-4">
        <div className="relative w-full max-w-md bg-[#0C2C4A] border border-[#164468] rounded-2xl shadow-2xl p-6 sm:p-8 flex flex-col gap-6 overflow-hidden">
          {/* Subtle Accent Glow */}
          <div className="absolute -top-20 -right-20 w-48 h-48 rounded-full bg-[#38BDF8]/10 blur-3xl pointer-events-none"></div>

          {/* Access Denied Header */}
          <div className="flex flex-col items-center text-center gap-2">
            <div className="w-14 h-14 rounded-2xl bg-[#FB7185]/15 border border-[#FB7185]/30 flex items-center justify-center text-[#FB7185] shadow-[0_0_20px_rgba(251,113,133,0.25)]">
              <span className="material-symbols-outlined text-3xl">shield</span>
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-[#FB7185]/10 text-[#FB7185] text-xs font-mono-code font-bold uppercase tracking-wider mt-1">
              <span>AUTHENTICATION REQUIRED</span>
            </div>
            <h1 className="font-display-title text-2xl font-bold text-white mt-1">
              MSAP Council Gate Console
            </h1>
            <p className="text-xs text-[#9DB8CF]">
              Restricted Administrative Terminal for 53rd Freshers' Meet 2026. Only authorized council marshals may log in.
            </p>
          </div>

          {/* Login Form */}
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-[#9DB8CF] font-mono-code">ADMINISTRATOR EMAIL</label>
              <div className="relative">
                <input
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="admin@msap.org"
                  className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm text-white border border-[#164468] outline-none focus:border-[#38BDF8] transition-colors placeholder:text-[#9DB8CF]/50"
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-lg">
                  badge
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-[#9DB8CF] font-mono-code">PASSWORD</label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm text-white border border-[#164468] outline-none focus:border-[#38BDF8] transition-colors placeholder:text-[#9DB8CF]/50"
                />
                <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-lg">
                  lock
                </span>
              </div>
            </div>

            {loginError && (
              <div className="p-3 rounded-xl bg-[#FB7185]/15 border border-[#FB7185]/40 text-[#FB7185] text-xs font-semibold">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full mt-2 py-3 rounded-xl bg-gradient-to-r from-[#0284C7] to-[#38BDF8] hover:from-[#38BDF8] hover:to-[#7DD3FC] text-[#061A2E] font-bold text-sm shadow-[0_0_20px_rgba(56,189,248,0.35)] hover:shadow-[0_0_30px_rgba(56,189,248,0.55)] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">
                {isLoggingIn ? 'progress_activity' : 'login'}
              </span>
              <span>{isLoggingIn ? 'Verifying Credentials...' : 'Authenticate & Unlock Console'}</span>
            </button>
          </form>

          {/* Credentials Helper */}
          <div className="p-3 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1 text-[11px] font-mono-code text-[#9DB8CF]">
            <span className="text-[#38BDF8] font-bold">Council Administration Access:</span>
            <span>Email: <strong className="text-white">admin@msap.org</strong></span>
            <span>Password: <span className="text-[#9DB8CF]">Configured via environment variables</span></span>
          </div>

          <div className="text-center">
            <a
              href="/"
              className="text-xs text-[#9DB8CF] hover:text-[#38BDF8] transition-colors underline"
            >
              Return to Public Ticket Portal
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------
  // AUTHENTICATED STATE: FULL ADMIN DASHBOARD & SCANNER
  // ----------------------------------------------------
  return (
    <div className="min-h-screen bg-[#061A2E] text-[#EAF6FF]">
      {/* Top Admin Navigation Header */}
      <header className="sticky top-0 z-40 bg-[#061A2E]/95 backdrop-blur-md border-b border-[#164468]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#0284C7] to-[#38BDF8] flex items-center justify-center text-[#061A2E] font-bold text-xs shadow-md">
              MSAP
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display-title font-bold text-white text-base">Admin Operations</span>
                <span className="px-2 py-0.5 rounded bg-[#34D399]/15 text-[#34D399] text-[10px] font-mono-code font-bold border border-[#34D399]/30">
                  MYSQL LIVE
                </span>
              </div>
              <span className="text-[11px] text-[#9DB8CF]">53rd Freshers' Meet 2026 • Gate Operations</span>
            </div>
          </div>

          {/* Admin User Info & Logout */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-semibold text-white">{adminUser.email}</span>
              <span className="text-[10px] font-mono-code text-[#38BDF8] uppercase">{adminUser.role} ACCESS</span>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0C2C4A] hover:bg-[#103A5F] text-[#FB7185] text-xs font-semibold border border-[#FB7185]/30 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">logout</span>
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>

        {/* Tab Selector Bar */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-[#164468]/60 flex items-center gap-2 overflow-x-auto py-2">
          <button
            onClick={() => { setActiveTab('dashboard'); fetchDashboardStats(); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'dashboard'
                ? 'bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] shadow-md font-bold'
                : 'text-[#9DB8CF] hover:text-white hover:bg-[#0C2C4A]'
            }`}
          >
            <span className="material-symbols-outlined text-base">analytics</span>
            <span>Dashboard & Metrics</span>
          </button>

          <button
            onClick={() => { setActiveTab('attendees'); fetchAttendeesList(); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'attendees'
                ? 'bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] shadow-md font-bold'
                : 'text-[#9DB8CF] hover:text-white hover:bg-[#0C2C4A]'
            }`}
          >
            <span className="material-symbols-outlined text-base">group</span>
            <span>Attendee Management & Payments</span>
          </button>

          <button
            onClick={() => { setActiveTab('scanner'); stopCamera(); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'scanner'
                ? 'bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] shadow-md font-bold'
                : 'text-[#9DB8CF] hover:text-white hover:bg-[#0C2C4A]'
            }`}
          >
            <span className="material-symbols-outlined text-base">qr_code_scanner</span>
            <span>Live Camera QR Scanner & Admission</span>
          </button>
        </div>
      </header>

      {/* Main Admin View Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* ================= TAB 1: DASHBOARD METRICS ================= */}
        {activeTab === 'dashboard' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-display-title font-bold text-white">Event Operational Metrics</h2>
                <p className="text-xs text-[#9DB8CF]">Real-time telemetry directly queried from MySQL database</p>
              </div>
              <button
                onClick={() => fetchDashboardStats()}
                disabled={statsLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0C2C4A] hover:bg-[#103A5F] text-[#38BDF8] text-xs font-semibold border border-[#164468] cursor-pointer transition-colors"
              >
                <span className={`material-symbols-outlined text-sm ${statsLoading ? 'animate-spin' : ''}`}>
                  refresh
                </span>
                <span>Refresh Stats</span>
              </button>
            </div>

            {/* Metric Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {/* TOTAL REGISTERED */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase font-bold">TOTAL REGISTERED</span>
                <span className="text-3xl font-bold font-display-title text-white">
                  {stats?.total_registered ?? '...'}
                </span>
                <span className="text-[10px] text-[#38BDF8]">All registrations in registry</span>
              </div>

              {/* SUBMITTED PAYMENTS (NEEDS REVIEW) */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#FDBA74]/50 shadow-[0_0_15px_rgba(253,186,116,0.15)] flex flex-col gap-1 cursor-pointer hover:bg-[#103A5F] transition-all"
                   onClick={() => { setPaymentFilter('PAYMENT_SUBMITTED'); setActiveTab('attendees'); }}>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono-code text-[#FDBA74] uppercase font-bold">PAYMENTS TO VERIFY</span>
                  <span className="w-2 h-2 rounded-full bg-[#FDBA74] animate-ping"></span>
                </div>
                <span className="text-3xl font-bold font-display-title text-[#FDBA74]">
                  {stats?.submitted_payments ?? 0}
                </span>
                <span className="text-[10px] text-[#FDBA74]">UTR submitted • Needs review</span>
              </div>

              {/* TOTAL PAID (TICKETS ISSUED) */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#34D399]/30 flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#34D399] uppercase font-bold">TICKETS ISSUED (PAID)</span>
                <span className="text-3xl font-bold font-display-title text-[#34D399]">
                  {(stats?.successful_payments ?? stats?.tickets_generated) ?? '...'}
                </span>
                <span className="text-[10px] text-[#34D399]">Verified UPI payments</span>
              </div>

              {/* REJECTED PAYMENTS */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#FB7185]/30 flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#FB7185] uppercase font-bold">REJECTED PAYMENTS</span>
                <span className="text-3xl font-bold font-display-title text-[#FB7185]">
                  {stats?.rejected_payments ?? 0}
                </span>
                <span className="text-[10px] text-[#FB7185]">Invalid UTR / Needs resubmission</span>
              </div>

              {/* TOTAL CHECKED IN */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#38BDF8]/30 flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#38BDF8] uppercase font-bold">TOTAL CHECKED IN</span>
                <span className="text-3xl font-bold font-display-title text-[#38BDF8]">
                  {stats?.total_checked_in ?? '...'}
                </span>
                <span className="text-[10px] text-[#9DB8CF]">Admitted past venue gate</span>
              </div>

              {/* NOT CHECKED IN */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase font-bold">NOT CHECKED IN</span>
                <span className="text-3xl font-bold font-display-title text-[#EAF6FF]">
                  {stats?.not_checked_in ?? '...'}
                </span>
                <span className="text-[10px] text-[#9DB8CF]">Yet to arrive at gate</span>
              </div>

              {/* TOTAL FRESHERS */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#FDBA74]/30 flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#FDBA74] uppercase font-bold">TOTAL FRESHERS</span>
                <span className="text-3xl font-bold font-display-title text-[#FDBA74]">
                  {stats?.total_freshers ?? '...'}
                </span>
                <span className="text-[10px] text-[#9DB8CF]">Class of 2026</span>
              </div>

              {/* TOTAL SENIORS */}
              <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#38BDF8]/30 flex flex-col gap-1">
                <span className="text-[11px] font-mono-code text-[#38BDF8] uppercase font-bold">TOTAL SENIORS</span>
                <span className="text-3xl font-bold font-display-title text-[#38BDF8]">
                  {stats?.total_seniors ?? '...'}
                </span>
                <span className="text-[10px] text-[#9DB8CF]">Senior hosts & council</span>
              </div>
            </div>

            {/* Event Settings - only the three requested editable fields */}
            <div className="p-5 rounded-2xl bg-[#0C2C4A] border border-[#164468] shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-display-title font-bold text-white text-base">Event Settings</h3>
                  <p className="text-xs text-[#9DB8CF]">Change the live time, venue, or registration price without editing code.</p>
                </div>
                <button
                  type="button"
                  onClick={() => fetchEventSettings()}
                  disabled={eventSettingsLoading || eventSettingsSaving}
                  className="px-3 py-1.5 rounded-xl bg-[#061A2E] hover:bg-[#103A5F] text-[#38BDF8] text-xs font-semibold border border-[#164468] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {eventSettingsLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase font-bold">TIME</span>
                  <input
                    type="text"
                    value={eventTimeInput}
                    onChange={(e) => setEventTimeInput(e.target.value)}
                    placeholder="5:30 PM Sharp"
                    className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm text-white border border-[#164468] outline-none focus:border-[#38BDF8]"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase font-bold">VENUE</span>
                  <input
                    type="text"
                    value={eventVenueInput}
                    onChange={(e) => setEventVenueInput(e.target.value)}
                    placeholder="Pune (MSAP Campus Main Auditorium)"
                    className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm text-white border border-[#164468] outline-none focus:border-[#38BDF8]"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase font-bold">REGISTRATION PRICE (₹)</span>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    inputMode="decimal"
                    value={eventPriceInput}
                    onChange={(e) => setEventPriceInput(e.target.value)}
                    placeholder="350"
                    className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-sm text-white border border-[#164468] outline-none focus:border-[#38BDF8]"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-[11px] text-[#9DB8CF]">
                  Current: <span className="text-white font-semibold">{eventSettings ? eventSettings.time : '...'}</span>
                  {' • '}
                  <span className="text-white font-semibold">{eventSettings ? eventSettings.venue : '...'}</span>
                  {' • '}
                  <span className="text-[#34D399] font-semibold">₹{eventSettings?.registrationPrice ?? '...'}</span>
                </div>
                <button
                  type="button"
                  onClick={handleSaveEventSettings}
                  disabled={eventSettingsSaving || eventSettingsLoading}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] text-xs font-bold shadow-md transition-all cursor-pointer disabled:opacity-50"
                >
                  {eventSettingsSaving ? 'Saving...' : 'Save Event Settings'}
                </button>
              </div>

              {eventSettingsMessage && (
                <div className="mt-3 p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] text-xs font-mono-code text-[#EAF6FF]">
                  {eventSettingsMessage}
                </div>
              )}
            </div>

            {/* Quick Actions Shortcuts */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <div
                onClick={() => { setPaymentFilter('PENDING'); setActiveTab('attendees'); }}
                className="p-5 rounded-2xl bg-[#0C2C4A] hover:bg-[#103A5F] border border-[#164468] transition-all cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-[#FDBA74]/15 text-[#FDBA74] flex items-center justify-center">
                    <span className="material-symbols-outlined text-2xl">receipt_long</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-sm">Review Pending Payments</h3>
                    <p className="text-xs text-[#9DB8CF]">Verify UTR bank receipts and activate digital passes</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-white">chevron_right</span>
              </div>

              <div
                onClick={() => setActiveTab('scanner')}
                className="p-5 rounded-2xl bg-[#0C2C4A] hover:bg-[#103A5F] border border-[#164468] transition-all cursor-pointer flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-[#38BDF8]/15 text-[#38BDF8] flex items-center justify-center">
                    <span className="material-symbols-outlined text-2xl">qr_code_scanner</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-sm">Launch Gate QR Scanner</h3>
                    <p className="text-xs text-[#9DB8CF]">Fast admission turnstile with duplicate check protection</p>
                  </div>
                </div>
                <span className="material-symbols-outlined text-white">chevron_right</span>
              </div>
            </div>
          </div>
        )}

        {/* ================= TAB 2: ATTENDEE MANAGEMENT & PAYMENTS ================= */}
        {activeTab === 'attendees' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-display-title font-bold text-white">Attendee Registry</h2>
                <p className="text-xs text-[#9DB8CF]">
                  Showing {attendees.length} of {attendeesTotal} attendees registered in MySQL
                </p>
              </div>

              {actionMessage && (
                <div className="p-2 rounded-xl bg-[#0C2C4A] border border-[#34D399]/40 text-xs font-mono-code text-[#34D399]">
                  {actionMessage}
                </div>
              )}
            </div>

            {/* Filters and Search Bar */}
            <div className="p-4 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-wrap items-center gap-3">
              {/* Search */}
              <div className="relative flex-1 min-w-[200px]">
                <input
                  type="text"
                  placeholder="Search by Ticket ID, Name, Phone, Email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-[#061A2E] px-3.5 py-2 pl-9 rounded-xl text-xs text-white border border-[#164468] outline-none focus:border-[#38BDF8] placeholder:text-[#9DB8CF]/50"
                />
                <span className="material-symbols-outlined absolute left-2.5 top-2 text-[#9DB8CF] text-base">
                  search
                </span>
              </div>

              {/* Category Filter */}
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="bg-[#061A2E] px-3 py-2 rounded-xl text-xs text-[#EAF6FF] border border-[#164468] outline-none cursor-pointer"
              >
                <option value="ALL">All Cohorts</option>
                <option value="FRESHER">Fresher</option>
                <option value="SENIOR">Senior</option>
              </select>

              {/* Payment Filter */}
              <select
                value={paymentFilter}
                onChange={(e) => setPaymentFilter(e.target.value)}
                className="bg-[#061A2E] px-3 py-2 rounded-xl text-xs text-[#EAF6FF] border border-[#164468] outline-none cursor-pointer"
              >
                <option value="ALL">All Payments</option>
                <option value="PAYMENT_SUBMITTED">Payment Submitted (Needs Review)</option>
                <option value="PAID">Paid (Active Ticket)</option>
                <option value="PENDING">Pending (No UTR)</option>
                <option value="REJECTED">Payment Rejected</option>
                <option value="REFUNDED">Refunded / Revoked</option>
              </select>

              {/* Check-In Filter */}
              <select
                value={checkInFilter}
                onChange={(e) => setCheckInFilter(e.target.value)}
                className="bg-[#061A2E] px-3 py-2 rounded-xl text-xs text-[#EAF6FF] border border-[#164468] outline-none cursor-pointer"
              >
                <option value="ALL">All Check-Ins</option>
                <option value="CHECKED_IN">Checked In</option>
                <option value="NOT_CHECKED_IN">Not Checked In</option>
              </select>

              <button
                onClick={() => fetchAttendeesList()}
                className="px-3 py-2 rounded-xl bg-[#0284C7] hover:bg-[#38BDF8] text-[#061A2E] text-xs font-bold transition-colors cursor-pointer"
              >
                Apply
              </button>
            </div>

            {/* Attendee Table */}
            <div className="rounded-2xl bg-[#0C2C4A] border border-[#164468] overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#061A2E] text-[#9DB8CF] font-mono-code text-[11px] uppercase border-b border-[#164468]">
                    <tr>
                      <th className="px-3 py-3">Reg ID</th>
                      <th className="px-3 py-3">Ticket ID</th>
                      <th className="px-4 py-3">Candidate Name</th>
                      <th className="px-3 py-3">Contact</th>
                      <th className="px-3 py-3">College</th>
                      <th className="px-3 py-3">Cohort</th>
                      <th className="px-3 py-3">Payment</th>
                      <th className="px-3 py-3">Bank UTR</th>
                      <th className="px-3 py-3">Check-In</th>
                      <th className="px-3 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#164468]">
                    {attendeesLoading ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-8 text-center text-[#9DB8CF]">
                          <span className="material-symbols-outlined animate-spin text-2xl text-[#38BDF8]">
                            progress_activity
                          </span>
                          <p className="mt-1">Loading attendee records from database...</p>
                        </td>
                      </tr>
                    ) : attendees.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-8 text-center text-[#9DB8CF]">
                          No attendee records matching your filters.
                        </td>
                      </tr>
                    ) : (
                      attendees.map((a) => (
                        <tr key={a.id} className="hover:bg-[#103A5F] transition-colors">
                          <td className="px-3 py-3 font-mono-code font-bold text-xs text-[#38BDF8] whitespace-nowrap">
                            {a.registration_id || `REG-${String(a.id).padStart(4, '0')}`}
                          </td>
                          <td className="px-3 py-3 font-mono-code font-bold text-xs text-[#34D399] whitespace-nowrap">
                            {a.ticket_id || <span className="text-[#9DB8CF]/60 font-normal text-[10px]">NOT GENERATED</span>}
                          </td>
                          <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">
                            {a.full_name}
                          </td>
                          <td className="px-3 py-3 text-[#9DB8CF] whitespace-nowrap">
                            <div>{a.phone}</div>
                            <div className="text-[10px] text-[#9DB8CF]/70">{a.email}</div>
                          </td>
                          <td className="px-3 py-3 text-[#9DB8CF] truncate max-w-[130px]" title={a.college}>
                            {a.college}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded font-mono-code text-[10px] font-bold ${
                                a.category === 'SENIOR'
                                  ? 'bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/40'
                                  : 'bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/40'
                              }`}
                            >
                              {a.category}
                            </span>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded font-mono-code text-[10px] font-bold flex items-center gap-1 w-max ${
                                a.payment_status === 'PAID'
                                  ? 'bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/40'
                                  : a.payment_status === 'PAYMENT_SUBMITTED'
                                  ? 'bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/40'
                                  : a.payment_status === 'REJECTED'
                                  ? 'bg-[#FB7185]/15 text-[#FB7185] border border-[#FB7185]/40'
                                  : 'bg-[#061A2E] text-[#9DB8CF] border border-[#164468]'
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${a.payment_status === 'PAID' ? 'bg-[#34D399]' : a.payment_status === 'PAYMENT_SUBMITTED' ? 'bg-[#FDBA74] animate-ping' : a.payment_status === 'REJECTED' ? 'bg-[#FB7185]' : 'bg-[#9DB8CF]'}`}></span>
                              <span>{a.payment_status}</span>
                            </span>
                          </td>
                          <td className="px-3 py-3 font-mono-code text-xs text-[#EAF6FF] whitespace-nowrap">
                            {a.payment_utr ? (
                              <span className="font-bold text-[#38BDF8]">{a.payment_utr}</span>
                            ) : (
                              <span className="text-[#9DB8CF]/40 italic">None</span>
                            )}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded font-mono-code text-[10px] font-bold ${
                                a.check_in_status === 'CHECKED_IN'
                                  ? 'bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/30'
                                  : 'bg-[#061A2E] text-[#9DB8CF] border border-[#164468]'
                              }`}
                            >
                              {a.check_in_status === 'CHECKED_IN' ? 'CHECKED IN' : 'NOT ARRIVED'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right whitespace-nowrap">
                            <button
                              onClick={() => setSelectedAttendee(a)}
                              className={`px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                                a.payment_status === 'PAYMENT_SUBMITTED'
                                  ? 'bg-[#FDBA74]/15 hover:bg-[#FDBA74]/25 text-[#FDBA74] border-[#FDBA74]/40 font-bold'
                                  : 'bg-[#061A2E] hover:bg-[#103A5F] text-[#38BDF8] border-[#164468]'
                              }`}
                            >
                              {a.payment_status === 'PAYMENT_SUBMITTED' ? 'Review & Verify' : 'View / Edit'}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Attendee Details & Payment Approval Modal */}
            {selectedAttendee && (
              <div className="fixed inset-0 z-50 bg-[#061A2E]/80 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-[#0C2C4A] border border-[#164468] rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#164468] pb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono-code font-bold text-lg text-[#38BDF8]">
                        {selectedAttendee.ticket_id || 'PENDING (NO PASS)'}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded font-mono-code text-xs font-bold ${
                          selectedAttendee.category === 'SENIOR' ? 'bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/30' : 'bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30'
                        }`}
                      >
                        {selectedAttendee.category}
                      </span>
                    </div>
                    <button
                      onClick={() => setSelectedAttendee(null)}
                      className="text-[#9DB8CF] hover:text-white cursor-pointer"
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>

                  {/* Information Grid */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">REGISTRATION ID</span>
                      <span className="font-mono-code font-bold text-[#38BDF8]">{selectedAttendee.registration_id}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">FULL NAME</span>
                      <span className="font-bold text-white text-sm">{selectedAttendee.full_name}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">PHONE</span>
                      <span className="font-semibold text-white">{selectedAttendee.phone}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">EMAIL</span>
                      <span className="font-semibold text-white truncate">{selectedAttendee.email}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">COLLEGE / DEPT</span>
                      <span className="font-semibold text-white truncate">{selectedAttendee.college}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">COURSE / YEAR</span>
                      <span className="font-semibold text-white truncate">
                        {[selectedAttendee.course_class, selectedAttendee.academic_year].filter(Boolean).join(' / ') || 'N/A'}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">STUDENT ROLL ID</span>
                      <span className="font-semibold text-white">{selectedAttendee.student_roll_id || 'N/A'}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[#9DB8CF] font-mono-code">PAYMENT UTR</span>
                      <span className="font-mono-code font-bold text-[#38BDF8]">
                        {selectedAttendee.payment_utr || 'Direct Portal Intake'}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">PAYMENT SUBMITTED</span>
                      <span className="text-white font-semibold">{selectedAttendee.payment_submitted_at || 'Not submitted'}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">VERIFIED AT</span>
                      <span className="text-white font-semibold">{selectedAttendee.payment_confirmed_at || 'Not verified'}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">TICKET STATUS</span>
                      <span className="text-white font-semibold">{selectedAttendee.ticket_status || 'NOT_GENERATED'}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">TICKET GENERATED</span>
                      <span className="text-white font-semibold">{selectedAttendee.ticket_id ? (selectedAttendee.payment_confirmed_at || 'Generated') : 'Not generated'}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">SCANNED BY</span>
                      <span className="text-white font-semibold">{selectedAttendee.checked_in_by || 'Not scanned'}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1">
                      <span className="text-[#9DB8CF] font-mono-code">ENTRY TIME</span>
                      <span className="text-white font-semibold">{selectedAttendee.check_in_time || 'Not entered'}</span>
                    </div>
                  </div>

                  {/* Payment Approval Control */}
                  <div className="p-4 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono-code text-[#9DB8CF]">PAYMENT STATUS</span>
                      <span
                        className={`px-2.5 py-0.5 rounded font-mono-code text-xs font-bold ${
                          selectedAttendee.payment_status === 'PAID'
                            ? 'bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/30'
                            : selectedAttendee.payment_status === 'REJECTED'
                            ? 'bg-[#FB7185]/15 text-[#FB7185] border border-[#FB7185]/30'
                            : 'bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30'
                        }`}
                      >
                        {selectedAttendee.payment_status}
                      </span>
                    </div>

                    {selectedAttendee.payment_status === 'PAYMENT_SUBMITTED' ? (
                      <div className="flex flex-col gap-3 mt-2">
                        <div className="p-3 rounded-xl bg-[#FDBA74]/10 border border-[#FDBA74]/30 flex flex-col gap-1.5">
                          <span className="text-[11px] font-mono-code font-bold text-[#FDBA74]">BANK UTR READY FOR REVIEW</span>
                          <span className="font-mono-code text-sm font-bold text-white">
                            {selectedAttendee.payment_utr || 'No UTR recorded'}
                          </span>
                          <p className="text-[11px] text-[#9DB8CF] leading-relaxed">
                            Confirm this reference against the bank statement before issuing the official entry ticket.
                          </p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <button
                            onClick={() => handleVerifyPayment(selectedAttendee.id)}
                            className="w-full py-2.5 rounded-xl bg-[#34D399] hover:bg-[#6EE7B7] text-[#061A2E] font-bold text-xs shadow-md transition-all cursor-pointer flex items-center justify-center gap-1.5"
                          >
                            <span className="material-symbols-outlined text-sm">verified</span>
                            <span>VERIFY & ISSUE PASS</span>
                          </button>
                          <button
                            onClick={() => handleRejectPayment(selectedAttendee.id)}
                            className="w-full py-2.5 rounded-xl bg-[#FB7185]/15 hover:bg-[#FB7185]/25 border border-[#FB7185]/40 text-[#FB7185] font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
                          >
                            <span className="material-symbols-outlined text-sm">block</span>
                            <span>REJECT UTR</span>
                          </button>
                        </div>
                      </div>
                    ) : selectedAttendee.payment_status === 'PENDING' || selectedAttendee.payment_status === 'PROCESSING' ? (
                      <div className="flex flex-col gap-2 mt-2">
                        <p className="text-xs text-[#FDBA74] leading-relaxed">
                          ⚠️ Primary confirmation must occur via payment gateway webhook. Use the button below only as an <strong>Emergency Admin Override</strong> with a mandatory audit justification.
                        </p>
                        <button
                          onClick={() => handleConfirmPayment(selectedAttendee.id)}
                          className="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 text-white font-bold text-xs shadow-md hover:brightness-110 transition-all cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">warning</span>
                          <span>EMERGENCY ADMIN OVERRIDE & ISSUE PASS</span>
                        </button>
                      </div>
                    ) : selectedAttendee.payment_status === 'PAID' ? (
                      <div className="flex flex-col gap-2 mt-1">
                        <div className="text-xs flex items-center gap-1.5">
                          {selectedAttendee.payment_confirmed_by?.includes('MANUAL_OVERRIDE') ? (
                            <span className="px-2 py-0.5 rounded bg-[#FDBA74]/15 text-[#FDBA74] font-mono-code font-bold text-[11px] flex items-center gap-1 border border-[#FDBA74]/30">
                              <span className="material-symbols-outlined text-xs">admin_panel_settings</span>
                              EMERGENCY MANUAL OVERRIDE (Audited)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-[#34D399]/15 text-[#34D399] font-mono-code font-bold text-[11px] flex items-center gap-1 border border-[#34D399]/30">
                              <span className="material-symbols-outlined text-xs">verified</span>
                              GATEWAY VERIFIED (Automated)
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[#9DB8CF]">
                          {selectedAttendee.payment_confirmed_by || 'Confirmed'} • Pass is active for gate scanning.
                        </p>
                        <button
                          onClick={() => handleRefundPayment(selectedAttendee.id)}
                          className="w-full py-2 mt-1 rounded-xl bg-[#FB7185]/15 hover:bg-[#FB7185]/25 border border-[#FB7185]/40 text-[#FB7185] font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">cancel</span>
                          <span>REFUND & REVOKE PASS</span>
                        </button>
                      </div>
                    ) : selectedAttendee.payment_status === 'REJECTED' ? (
                      <div className="flex flex-col gap-2 mt-1">
                        <div className="text-xs text-[#FB7185] flex items-center gap-1.5 font-mono-code font-bold">
                          <span className="material-symbols-outlined text-sm">block</span>
                          <span>PAYMENT REJECTED — WAITING FOR STUDENT RESUBMISSION</span>
                        </div>
                        {selectedAttendee.rejection_reason && (
                          <p className="text-[11px] text-[#9DB8CF] leading-relaxed">
                            Reason: {selectedAttendee.rejection_reason}
                          </p>
                        )}
                        <button
                          onClick={() => handleVerifyPayment(selectedAttendee.id)}
                          className="w-full py-2 mt-1 rounded-xl bg-[#34D399]/15 hover:bg-[#34D399]/25 border border-[#34D399]/40 text-[#34D399] font-bold text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">verified</span>
                          <span>VERIFY LATEST UTR & ISSUE PASS</span>
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-[#FB7185] flex items-center gap-1.5 mt-1 font-mono-code font-bold">
                        <span className="material-symbols-outlined text-sm">block</span>
                        <span>STATUS: {selectedAttendee.payment_status} — ENTRY PASS REVOKED</span>
                      </div>
                    )}
                  </div>

                  {/* Check-In Status */}
                  <div className="p-3 rounded-xl bg-[#061A2E] border border-[#164468] flex items-center justify-between text-xs font-mono-code">
                    <span className="text-[#9DB8CF]">CHECK-IN ADMITTANCE</span>
                    <span className={selectedAttendee.check_in_status === 'CHECKED_IN' ? 'text-[#34D399] font-bold' : 'text-[#9DB8CF]'}>
                      {selectedAttendee.check_in_status === 'CHECKED_IN'
                        ? `CHECKED IN AT ${selectedAttendee.check_in_time || 'GATE'}`
                        : 'NOT YET ADMITTED'}
                    </span>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      onClick={() => setSelectedAttendee(null)}
                      className="px-4 py-2 rounded-xl bg-[#103A5F] hover:bg-[#164468] text-white text-xs font-semibold cursor-pointer transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= TAB 3: LIVE CAMERA QR SCANNER & ADMISSION ================= */}
        {activeTab === 'scanner' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Camera / Scanner Feed (6 Cols) */}
            <div className="lg:col-span-6 flex flex-col gap-4">
              <div className="p-5 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#38BDF8]">videocam</span>
                    <h3 className="font-bold text-white text-base">Gate Camera Feed</h3>
                  </div>

                  <div className="flex items-center gap-2">
                    {cameraActive ? (
                      <button
                        onClick={stopCamera}
                        className="px-3 py-1 rounded-lg bg-[#FB7185]/15 text-[#FB7185] text-xs font-semibold border border-[#FB7185]/30 cursor-pointer transition-colors"
                      >
                        Stop Camera
                      </button>
                    ) : (
                      <button
                        onClick={startCamera}
                        className="px-3 py-1 rounded-lg bg-[#34D399]/15 text-[#34D399] text-xs font-semibold border border-[#34D399]/30 cursor-pointer transition-colors"
                      >
                        Start Camera
                      </button>
                    )}
                  </div>
                </div>

                {/* Video Viewport / Viewfinder */}
                <div className="relative aspect-video w-full rounded-xl bg-[#061A2E] border-2 border-dashed border-[#164468] flex items-center justify-center overflow-hidden">
                  {cameraActive ? (
                    <>
                      <video
                        ref={videoRef}
                        className="w-full h-full object-cover"
                        playsInline
                        muted
                      />
                      {/* Scanning Target Overlay */}
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="w-48 h-48 rounded-xl border-2 border-[#38BDF8] shadow-[0_0_20px_rgba(56,189,248,0.4)] relative animate-pulse">
                          <div className="absolute top-0 left-0 right-0 h-0.5 bg-[#38BDF8] shadow-[0_0_10px_#38BDF8] animate-bounce"></div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-center p-4">
                      <span className="material-symbols-outlined text-4xl text-[#9DB8CF]">
                        qr_code_scanner
                      </span>
                      <p className="text-xs text-[#9DB8CF]">
                        Click "Start Camera" to scan passes with your webcam / phone, or use the manual token entry below.
                      </p>
                    </div>
                  )}
                </div>

                {cameraError && (
                  <div className="p-2.5 rounded-xl bg-[#FDBA74]/15 border border-[#FDBA74]/30 text-[#FDBA74] text-xs">
                    {cameraError}
                  </div>
                )}

                {/* Manual Barcode / QR Token Entry Input */}
                <div className="flex flex-col gap-1.5 pt-2 border-t border-[#164468]">
                  <label className="text-xs font-mono-code font-bold text-[#9DB8CF]">
                    MANUAL QR TOKEN / BARCODE SCANNER INPUT
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Paste or scan QR Token / Access Token..."
                      value={scannerTokenInput}
                      onChange={(e) => setScannerTokenInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleVerifyQr(scannerTokenInput)}
                      className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl text-xs font-mono-code text-white border border-[#164468] outline-none focus:border-[#38BDF8] placeholder:text-[#9DB8CF]/50"
                    />
                    <button
                      onClick={() => handleVerifyQr(scannerTokenInput)}
                      disabled={scanLoading || !scannerTokenInput.trim()}
                      className="px-4 py-2.5 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] font-bold text-xs shrink-0 cursor-pointer disabled:opacity-50 transition-colors"
                    >
                      {scanLoading ? 'Checking...' : 'Verify'}
                    </button>
                  </div>
                  <span className="text-[10px] text-[#9DB8CF]">
                    Supports handheld USB barcode scanners and copy-pasted QR tokens.
                  </span>
                </div>
              </div>
            </div>

            {/* Right: Verification & Admittance Decision Panel (6 Cols) */}
            <div className="lg:col-span-6 flex flex-col gap-4">
              {checkInSuccessMsg && (
                <div className="p-4 rounded-2xl bg-[#34D399]/15 border border-[#34D399] text-[#34D399] font-bold text-sm shadow-[0_0_20px_rgba(52,211,153,0.3)] flex items-center gap-2">
                  <span className="material-symbols-outlined text-2xl">celebration</span>
                  <span>{checkInSuccessMsg}</span>
                </div>
              )}

              {scanResult ? (
                <div className="p-6 rounded-2xl bg-[#0C2C4A] border border-[#164468] shadow-xl flex flex-col gap-5">
                  {/* CASE 1: VALID TICKET */}
                  {scanResult.status === 'VALID' && scanResult.attendee && (
                    <>
                      <div className="p-3.5 rounded-xl bg-[#34D399]/15 border border-[#34D399]/50 text-[#34D399] flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-2xl">check_circle</span>
                          <span className="font-bold text-sm font-mono-code">✅ VALID TICKET • READY FOR ENTRY</span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-[#34D399] text-[#061A2E] font-bold text-[10px]">
                          PAID
                        </span>
                      </div>

                      {/* Candidate Identity Card */}
                      <div className="p-4 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-2.5">
                        <div className="flex items-center justify-between">
                          <span className="font-mono-code text-xl font-bold text-[#38BDF8]">
                            {scanResult.attendee.ticket_id}
                          </span>
                          <span
                            className={`px-2.5 py-0.5 rounded font-mono-code text-xs font-bold ${
                              scanResult.attendee.category === 'SENIOR'
                                ? 'bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/30'
                                : 'bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30'
                            }`}
                          >
                            {scanResult.attendee.category}
                          </span>
                        </div>

                        <div className="text-base font-bold text-white">
                          {scanResult.attendee.full_name}
                        </div>

                        <div className="text-xs text-[#9DB8CF] grid grid-cols-2 gap-2 pt-1 border-t border-[#164468]">
                          <div>College: <span className="text-white">{scanResult.attendee.college}</span></div>
                          <div>Phone: <span className="text-white">{scanResult.attendee.phone}</span></div>
                        </div>
                      </div>

                      {/* Confirm Admittance Action */}
                      <button
                        onClick={() => handleConfirmEntry(scanResult.attendee!.id)}
                        disabled={checkInLoading}
                        className="w-full py-4 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#059669] to-[#34D399] text-[#061A2E] font-bold text-base shadow-[0_0_24px_rgba(52,211,153,0.35)] hover:shadow-[0_0_32px_rgba(52,211,153,0.55)] hover:scale-[1.01] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-2xl">door_front</span>
                        <span>{checkInLoading ? 'Recording Transaction in MySQL...' : 'CONFIRM ENTRY (ADMIT ATTENDEE)'}</span>
                      </button>
                    </>
                  )}

                  {/* CASE 2: ALREADY CHECKED IN (ANTI-PASSBACK) */}
                  {scanResult.status === 'ALREADY_CHECKED_IN' && scanResult.attendee && (
                    <div className="flex flex-col gap-4">
                      <div className="p-3.5 rounded-xl bg-[#FB7185]/15 border border-[#FB7185]/50 text-[#FB7185] flex items-center gap-2">
                        <span className="material-symbols-outlined text-2xl">warning</span>
                        <div className="flex flex-col">
                          <span className="font-bold text-sm font-mono-code">⚠️ ALREADY CHECKED IN (ENTRY REJECTED)</span>
                          <span className="text-xs text-white/90">
                            Admitted earlier at {scanResult.attendee.check_in_time || 'earlier session'}. Anti-passback triggered.
                          </span>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-2 text-xs">
                        <div>Attendee: <strong className="text-white text-sm">{scanResult.attendee.full_name}</strong></div>
                        <div>Ticket ID: <strong className="text-[#38BDF8] font-mono-code">{scanResult.attendee.ticket_id}</strong></div>
                        <div>Category: <strong className="text-white">{scanResult.attendee.category}</strong></div>
                      </div>
                    </div>
                  )}

                  {/* CASE 3: PAYMENT NOT CONFIRMED */}
                  {scanResult.status === 'PAYMENT_NOT_CONFIRMED' && scanResult.attendee && (
                    <div className="flex flex-col gap-4">
                      <div className="p-3.5 rounded-xl bg-[#FDBA74]/15 border border-[#FDBA74]/50 text-[#FDBA74] flex items-center gap-2">
                        <span className="material-symbols-outlined text-2xl">hourglass_top</span>
                        <div className="flex flex-col">
                          <span className="font-bold text-sm font-mono-code">⚠️ PAYMENT NOT CONFIRMED</span>
                          <span className="text-xs text-white/90">
                            Ticket registered, but the configured registration fee has not been verified or marked as PAID in MySQL.
                          </span>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-2 text-xs">
                        <div>Attendee: <strong className="text-white text-sm">{scanResult.attendee.full_name}</strong></div>
                        <div>Ticket ID: <strong className="text-[#38BDF8] font-mono-code">{scanResult.attendee.ticket_id || 'PENDING (NO PASS)'}</strong></div>
                      </div>

                      <button
                        onClick={async () => {
                          await handleConfirmPayment(scanResult.attendee!.id);
                          await handleVerifyQr(scannerTokenInput);
                        }}
                        className="w-full py-3 rounded-xl bg-[#FDBA74] hover:bg-[#FDBA74]/90 text-[#061A2E] font-bold text-xs cursor-pointer shadow-md transition-all"
                      >
                        Confirm Payment Now & Issue Entry Pass
                      </button>
                    </div>
                  )}

                  {/* CASE 4: ENTRY PASS REVOKED */}
                  {scanResult.status === 'ENTRY_PASS_REVOKED' && (
                    <div className="p-5 rounded-xl bg-[#FB7185]/15 border border-[#FB7185] text-[#FB7185] flex items-center gap-3">
                      <span className="material-symbols-outlined text-3xl">block</span>
                      <div className="flex flex-col">
                        <span className="font-bold text-base font-mono-code">⛔ ENTRY PASS REVOKED</span>
                        <span className="text-xs text-white/80 mt-1">
                          {scanResult.message || 'This ticket pass has been revoked or invalidated by administration.'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* CASE 5: INVALID TICKET */}
                  {scanResult.status === 'INVALID' && (
                    <div className="p-5 rounded-xl bg-[#FB7185]/15 border border-[#FB7185] text-[#FB7185] flex items-center gap-3">
                      <span className="material-symbols-outlined text-3xl">cancel</span>
                      <div className="flex flex-col">
                        <span className="font-bold text-base font-mono-code">❌ INVALID TICKET</span>
                        <span className="text-xs text-white/80 mt-1">
                          {scanResult.message || 'QR code signature does not exist in MySQL database.'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 rounded-2xl bg-[#0C2C4A] border border-[#164468] flex flex-col items-center justify-center text-center gap-2 min-h-[260px]">
                  <span className="material-symbols-outlined text-4xl text-[#9DB8CF]">
                    fingerprint
                  </span>
                  <h4 className="font-bold text-white text-sm">Awaiting Pass Scan</h4>
                  <p className="text-xs text-[#9DB8CF] max-w-xs">
                    Scan student QR token or input manual ID on the left to verify admission rights and gate check-in status.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
