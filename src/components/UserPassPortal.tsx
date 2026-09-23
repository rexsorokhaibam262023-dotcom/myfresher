import React, { useState, useEffect } from 'react';
import { AttendeeCategory, DigitalPassData, PaymentStatus, EventSettings } from '../types';
import { MasterTicketCanvas } from './MasterTicketCanvas';

declare global {
  interface Window {
    Razorpay: any;
  }
}

const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let razorpayScriptPromise: Promise<void> | null = null;
function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => {
      razorpayScriptPromise = null;
      reject(new Error('Failed to load Razorpay checkout script.'));
    };
    document.body.appendChild(script);
  });
  return razorpayScriptPromise;
}

interface UserPassPortalProps {
  initialAccessToken?: string;
}

export const UserPassPortal: React.FC<UserPassPortalProps> = ({ initialAccessToken }) => {
  // Pass State
  const [ticketData, setTicketData] = useState<DigitalPassData>({
    ticketId: '',
    fullName: '',
    category: 'FRESHER',
    college: '',
    paymentStatus: 'PENDING',
    entryPassStatus: 'NOT_CREATED',
    checkInStatus: 'NOT_CHECKED_IN',
    eventDate: '02 OCT 2026',
    doorsOpen: '5:30 PM Sharp',
    venue: 'Pune (MSAP Campus Main Auditorium)',
    eventName: "53rd Freshers' Meet 2026",
    organization: "Manipur Students' Association Pune (MSAP)",
    amount: '₹350',
    qrToken: '',
    paymentUtr: '',
  });

  const [eventSettings, setEventSettings] = useState<EventSettings>({
    time: '5:30 PM Sharp',
    venue: 'Pune (MSAP Campus Main Auditorium)',
    registrationPrice: 350,
    updatedAt: '',
  });

  const [hashStamp, setHashStamp] = useState('SHA256: 8F7C•••E29A');
  const [isCopied, setIsCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [walletAdded, setWalletAdded] = useState(false);
  const [searchPhone, setSearchPhone] = useState('');
  const [searchKey, setSearchKey] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  // Form State
  const [inputName, setInputName] = useState('');
  const [inputPhone, setInputPhone] = useState('');
  const [inputEmail, setInputEmail] = useState('');
  const [inputRoll, setInputRoll] = useState('');
  const [inputDept, setInputDept] = useState('');
  const [inputCourseClass, setInputCourseClass] = useState('');
  const [inputAcademicYear, setInputAcademicYear] = useState('');
  const [selectedCohort, setSelectedCohort] = useState<AttendeeCategory>('FRESHER');
  const [submitting, setSubmitting] = useState(false);
  const [formSuccessMessage, setFormSuccessMessage] = useState<string | null>(null);
  const [formErrorMessage, setFormErrorMessage] = useState<string | null>(null);
  const [showGoogleFormModal, setShowGoogleFormModal] = useState(false);

  // Unified Flow & Step State
  const [currentStep, setCurrentStep] = useState<1 | 2>(initialAccessToken ? 2 : 1);
  const [showRetrieveDrawer, setShowRetrieveDrawer] = useState(false);
  const [activeSessionToken, setActiveSessionToken] = useState<string | null>(initialAccessToken || null);
  const [activeAccessToken, setActiveAccessToken] = useState<string | null>(initialAccessToken || null);
  const [onlinePayLoading, setOnlinePayLoading] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);

  const loadEventSettings = async () => {
    try {
      const res = await fetch('/api/event-settings');
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings) {
        const settings: EventSettings = data.settings;
        setEventSettings(settings);
        setTicketData((prev) => ({
          ...prev,
          doorsOpen: settings.time,
          venue: settings.venue,
          amount: `₹${settings.registrationPrice}`,
        }));
      }
    } catch (err) {
      console.warn('Event settings could not be loaded; using current local display values.', err);
    }
  };

  useEffect(() => {
    loadEventSettings();
  }, []);

  // Load pass if initialAccessToken is provided
  useEffect(() => {
    if (initialAccessToken) {
      setActiveAccessToken(initialAccessToken);
      setActiveSessionToken(initialAccessToken);
      loadPassByToken(initialAccessToken);
    }
  }, [initialAccessToken]);

  // Payment Status Polling
  // Automatically polls every 3 seconds until payment is verified or reaches terminal state
  useEffect(() => {
    const token = activeSessionToken || activeAccessToken;
    if (!token || ticketData.paymentStatus === 'PAID') return;
    if (ticketData.paymentStatus === 'FAILED' || ticketData.paymentStatus === 'REFUNDED') return;

    let pollCount = 0;
    const maxPolls = 100; // Stop after ~5 minutes

    const interval = setInterval(async () => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(interval);
        return;
      }

      try {
        const res = await fetch(`/api/payments/status-by-token/${encodeURIComponent(token)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.isPaid || data.paymentStatus === 'PAID') {
            setPaymentMessage('✓ Payment verified! Unlocking Master Ticket…');
            await loadPassByToken(token);
            clearInterval(interval);
          } else if (data.paymentStatus === 'FAILED' || data.paymentStatus === 'REFUNDED') {
            setTicketData((prev) => ({ ...prev, paymentStatus: data.paymentStatus }));
            clearInterval(interval);
          }
        }
      } catch {
        // Silently retry on next interval tick
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeAccessToken, activeSessionToken, ticketData.paymentStatus]);

  // Online Payment via Razorpay (Instant Pass Unlock)
  const handleOnlinePayment = async () => {
    const token = activeSessionToken || activeAccessToken;
    if (!token) {
      setPaymentMessage('❌ Session expired or not established. Please complete registration or retrieve your pass.');
      return;
    }

    setOnlinePayLoading(true);
    setPaymentMessage('Initiating payment gateway session…');

    try {
      // 1. Create order on backend (amount strictly determined server-side)
      const orderRes = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token, sessionToken: token }),
      });
      const orderData = await orderRes.json();

      if (!orderRes.ok || !orderData.success) {
        setPaymentMessage(`❌ ${orderData.error || 'Failed to initiate online payment order.'}`);
        setOnlinePayLoading(false);
        return;
      }

      if (orderData.alreadyPaid) {
        setPaymentMessage('✓ Payment verified! Your Master Ticket is unlocked.');
        await loadPassByToken(token);
        setOnlinePayLoading(false);
        return;
      }

      const order = orderData.order;
      if (!order?.orderId || !order?.keyId) {
        setPaymentMessage('❌ Payment gateway is awaiting API credentials. Please configure Razorpay on the server.');
        setOnlinePayLoading(false);
        return;
      }

      await loadRazorpayScript();

      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: Math.round(order.amount * 100),
        currency: order.currency || 'INR',
        order_id: order.orderId,
        name: "MSAP 53rd Freshers' Meet 2026",
        description: 'All-Access Gala & Food Pass',
        prefill: {
          name: ticketData.fullName || inputName || undefined,
          email: inputEmail || undefined,
          contact: inputPhone || undefined,
        },
        theme: { color: '#38BDF8' },
        handler: async (response: any) => {
          setPaymentMessage('Verifying payment…');
          try {
            const verifyRes = await fetch('/api/payments/verify-checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accessToken: token,
                sessionToken: token,
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              }),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok || !verifyData.success) {
              setPaymentMessage(`❌ ${verifyData.error || 'Payment verification failed.'}`);
              setOnlinePayLoading(false);
              return;
            }
            setPaymentMessage('✓ Payment verified! Your Master Ticket is unlocked.');
            await loadPassByToken(token);
          } catch (err) {
            console.error('[PAYMENT VERIFY ERROR]', err);
            setPaymentMessage('❌ Network error verifying payment.');
          } finally {
            setOnlinePayLoading(false);
          }
        },
        modal: {
          ondismiss: () => {
            setPaymentMessage('❌ Payment window closed before completion.');
            setOnlinePayLoading(false);
          },
        },
      });

      rzp.on('payment.failed', (resp: any) => {
        setPaymentMessage(`❌ Payment failed: ${resp?.error?.description || 'Please try again.'}`);
        setOnlinePayLoading(false);
      });

      rzp.open();
    } catch (err) {
      console.error('[ONLINE PAYMENT ERROR]', err);
      setPaymentMessage('❌ Network error launching payment gateway.');
      setOnlinePayLoading(false);
    }
  };

  // Reset to Step 1 for new registration
  const handleNewRegistration = () => {
    setCurrentStep(1);
    setInputName('');
    setInputPhone('');
    setInputEmail('');
    setInputRoll('');
    setInputDept('');
    setInputCourseClass('');
    setInputAcademicYear('');
    setSelectedCohort('FRESHER');
    setPaymentMessage(null);
    setFormSuccessMessage(null);
    setFormErrorMessage(null);
    setActiveAccessToken(null);
    setActiveSessionToken(null);
    setTicketData({
      ticketId: '',
      fullName: '',
      category: 'FRESHER',
      college: '',
      paymentStatus: 'PENDING',
      entryPassStatus: 'NOT_CREATED',
      checkInStatus: 'NOT_CHECKED_IN',
      eventDate: '02 OCT 2026',
      doorsOpen: eventSettings.time,
      venue: eventSettings.venue,
      eventName: "53rd Freshers' Meet 2026",
      organization: "Manipur Students' Association Pune (MSAP)",
      amount: `₹${eventSettings.registrationPrice}`,
      qrToken: '',
      paymentUtr: '',
    });
  };

  // Canvas-based download: composite master ticket template with QR + ticket no + category
  const handleDownloadTicket = async () => {
    if (!ticketData.qrSvg && !ticketData.qrToken) {
      alert('Ticket QR code not available. Please ensure your payment is verified.');
      return;
    }

    setDownloading(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 443;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');

      // 1. Draw master ticket template as background
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, 0, 0, 1024, 443);
          resolve();
        };
        img.onerror = reject;
        img.src = '/master-ticket-template.jpg';
      });

      // 2. Generate QR code as image from SVG or token
      if (ticketData.qrSvg) {
        await new Promise<void>((resolve) => {
          const svgBlob = new Blob([ticketData.qrSvg!], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(svgBlob);
          const qrImg = new Image();
          qrImg.onload = () => {
            // QR code area on ticket stub: approx x=818, y=140, w=155, h=155
            ctx.drawImage(qrImg, 818, 140, 155, 155);
            URL.revokeObjectURL(url);
            resolve();
          };
          qrImg.onerror = () => { URL.revokeObjectURL(url); resolve(); };
          qrImg.src = url;
        });
      }

      // 3. Overlay Ticket Number — white text on the stub
      ctx.font = 'bold 14px Arial, sans-serif';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'left';
      const ticketNoValue = ticketData.ticketId || 'FM26-???';
      // Find the "FM26-XXX" area on the ticket stub — approximately y=345
      ctx.fillText(ticketNoValue, 830, 318);

      // 4. Overlay Category
      ctx.font = 'bold 13px Arial, sans-serif';
      ctx.fillStyle = '#1a1a2e';
      const categoryValue = ticketData.category === 'SENIOR' ? 'SENIOR' : 'FRESHER';
      ctx.fillText(categoryValue, 830, 380);

      // 5. Download as PNG
      const link = document.createElement('a');
      link.download = `MSAP-FM26-Ticket-${ticketData.ticketId || 'pass'}.png`;
      link.href = canvas.toDataURL('image/png', 1.0);
      link.click();
    } catch (err) {
      console.error('Ticket download error:', err);
      // Fallback: print
      window.print();
    } finally {
      setDownloading(false);
    }
  };

  const loadPassByToken = async (token: string) => {
    setActiveAccessToken(token);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(token)}`);
      const data = await res.json();
      if (res.ok && data.ticket) {
        setTicketData(data.ticket);
        setEventSettings((prev) => ({
          ...prev,
          time: data.ticket.doorsOpen || prev.time,
          venue: data.ticket.venue || prev.venue,
          registrationPrice: Number(String(data.ticket.amount || `₹${prev.registrationPrice}`).replace(/[^0-9.]/g, '')) || prev.registrationPrice,
        }));
        updateHashStamp();
      } else if (res.ok && (data.registrationId || data.attendee)) {
        const rec = data.attendee || data;
        setTicketData((prev) => ({
          ...prev,
          registrationId: rec.registrationId || rec.registration_id || prev.registrationId,
          ticketId: rec.ticketId || rec.ticket_id || null,
          fullName: rec.fullName || rec.full_name || prev.fullName,
          category: rec.category || prev.category,
          college: rec.college || prev.college,
          courseClass: rec.courseClass || rec.course_class || prev.courseClass,
          academicYear: rec.academicYear || rec.academic_year || prev.academicYear,
          paymentStatus: rec.paymentStatus || rec.payment_status || prev.paymentStatus,
          entryPassStatus: rec.entryPassStatus || rec.entry_pass_status || prev.entryPassStatus,
          ticketStatus: rec.ticketStatus || rec.ticket_status || prev.ticketStatus,
          checkInStatus: rec.checkInStatus || rec.check_in_status || prev.checkInStatus,
          checkInTime: rec.checkInTime || rec.check_in_time || prev.checkInTime,
          paymentUtr: rec.paymentUtr || rec.payment_utr || prev.paymentUtr,
          paymentSubmittedAt: rec.paymentSubmittedAt || rec.payment_submitted_at || prev.paymentSubmittedAt,
          rejectionReason: rec.rejectionReason || rec.rejection_reason || prev.rejectionReason,
          qrToken: null,
          qrSvg: '',
          qrDataUrl: '',
          eventDate: rec.eventDate || prev.eventDate,
          doorsOpen: rec.doorsOpen || prev.doorsOpen,
          venue: rec.venue || prev.venue,
          eventName: rec.eventName || prev.eventName,
          organization: rec.organization || prev.organization,
          amount: rec.amount || prev.amount,
        }));
        setEventSettings((prev) => ({
          ...prev,
          time: rec.doorsOpen || prev.time,
          venue: rec.venue || prev.venue,
          registrationPrice: Number(String(rec.amount || `₹${prev.registrationPrice}`).replace(/[^0-9.]/g, '')) || prev.registrationPrice,
        }));
      }
    } catch (err) {
      console.error('Error loading pass:', err);
    }
  };

  const updateHashStamp = () => {
    const randomHex = Math.random().toString(16).substring(2, 6).toUpperCase() + '•••' + Math.random().toString(16).substring(2, 6).toUpperCase();
    setHashStamp(`SHA256: ${randomHex}`);
  };

  // Search / Retrieve Pass
  const handleSearchPass = async () => {
    if (!searchPhone.trim() || !searchKey.trim()) {
      setSearchMessage('Enter your registered phone number and email or roll ID.');
      return;
    }
    setSearchLoading(true);
    setSearchMessage(null);

    try {
      const params = new URLSearchParams({ phone: searchPhone.trim(), key: searchKey.trim() });
      const res = await fetch(`/api/tickets/lookup?${params.toString()}`);
      const data = await res.json();

      if (res.ok && (data.accessToken || data.sessionToken)) {
        const token = data.sessionToken || data.accessToken;
        setActiveSessionToken(token);
        setActiveAccessToken(token);
        setSearchMessage(`✅ Record found for ${data.fullName || 'Student'}! Loading details...`);
        await loadPassByToken(token);
        setCurrentStep(2);
        setShowRetrieveDrawer(false);

        // Smooth scroll to unified card
        const el = document.getElementById('unifiedWorkflowCard');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-2', 'ring-[#38BDF8]');
          setTimeout(() => el.classList.remove('ring-2', 'ring-[#38BDF8]'), 1500);
        }
      } else {
        setSearchMessage(`❌ ${data.error || 'No matching attendee found. Try another search.'}`);
      }
    } catch {
      setSearchMessage('❌ Network lookup failed. Please try again.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Submit Registration Intake
  const handleSubmitRegistration = async () => {
    if (!inputName.trim() || !inputPhone.trim() || !inputEmail.trim()) {
      setFormErrorMessage('Please complete Full Name, WhatsApp / Mobile Number, and Learner Email.');
      return;
    }

    setSubmitting(true);
    setFormErrorMessage(null);
    setFormSuccessMessage(null);

    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: inputName.trim(),
          phone: inputPhone.trim(),
          email: inputEmail.trim(),
          college: inputDept,
          category: selectedCohort,
          rollId: inputRoll.trim() || undefined,
          courseClass: inputCourseClass.trim(),
          academicYear: inputAcademicYear.trim(),
        }),
      });

      const data = await res.json();

      if (res.ok && data.attendee) {
        const token = data.sessionToken || data.accessToken || data.attendee.session_token || data.attendee.access_token;
        if (token) {
          setActiveSessionToken(token);
          setActiveAccessToken(token);
        }
        setTicketData((prev) => ({
          ...prev,
          registrationId: data.attendee.registration_id,
          fullName: data.attendee.full_name || inputName.trim(),
          category: data.attendee.category || selectedCohort,
          college: data.attendee.college || inputDept,
          paymentStatus: data.attendee.payment_status || 'PENDING',
          paymentUtr: data.attendee.payment_utr || '',
          rejectionReason: data.attendee.rejection_reason || '',
          ticketId: data.attendee.ticket_id || null,
          qrToken: data.attendee.qr_token || null,
        }));
        setFormSuccessMessage(`✅ Registration saved! Registration ID: ${data.attendee.registration_id}. Continue to payment.`);
        setCurrentStep(2);
        if (token) {
          await loadPassByToken(token);
        }

        // Smooth scroll to payment section
        setTimeout(() => {
          const card = document.getElementById('unifiedWorkflowCard');
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.classList.add('ring-2', 'ring-[#38BDF8]');
            setTimeout(() => card.classList.remove('ring-2', 'ring-[#38BDF8]'), 1500);
          }
        }, 50);
      } else if (res.status === 409) {
        if (data.partialDuplicate) {
          setFormErrorMessage(`⚠️ ${data.message || 'A registration already exists with this phone or email. Please click "Retrieve Existing Pass" above to access your record.'}`);
        } else {
          setFormErrorMessage(data.message || data.error || 'A conflicting registration already exists.');
        }
      } else {
        setFormErrorMessage(data.error || 'Registration failed. Please verify your entries and try again.');
      }
    } catch {
      setFormErrorMessage('Unable to connect to registration server.');
    } finally {
      setSubmitting(false);
    }
  };

  // Copy Ticket ID
  const handleCopyTicket = () => {
    if (!ticketData.ticketId) return;
    navigator.clipboard.writeText(ticketData.ticketId).catch(() => {});
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Add to Wallet
  const handleAddToWallet = () => {
    setWalletAdded(true);
    setTimeout(() => setWalletAdded(false), 2500);
  };

  // Share via WhatsApp
  const handleShareWhatsApp = () => {
    const text = encodeURIComponent(
      `🎟️ My official pass for MSAP 53rd Freshers' Meet 2026 is confirmed!\n\n` +
      `Ticket ID: ${ticketData.ticketId}\n` +
      `Name: ${ticketData.fullName}\n` +
      `Date: 02 OCT 2026 | ${ticketData.venue}\nTime: ${ticketData.doorsOpen}\n\n` +
      `See you at the Gala!`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const isPaid = ticketData.paymentStatus === 'PAID';
  const upiId = eventSettings.upiId || 'msap@upi';
  const upiIntentUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent("MSAP Freshers Meet 2026")}&am=${eventSettings.registrationPrice}&cu=INR&tn=${encodeURIComponent(`MSAP2026_${ticketData.registrationId || 'PASS'}`)}`;

  return (
    <div className="w-full min-h-screen bg-[#061A2E] text-[#EAF6FF] antialiased">
      {/* ================= HEADER (PUBLIC - NO ADMIN LINKS AS SPECIFIED) ================= */}
      <header className="fixed top-0 left-0 right-0 w-full z-50 bg-[#061A2E]/95 backdrop-blur-2xl border-b border-[#164468]/60 shadow-[0_4px_30px_rgba(6,26,46,0.6)]">
        <div className="h-20 max-w-7xl mx-auto px-5 lg:px-12 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#0284C7] to-[#38BDF8] flex items-center justify-center shadow-[0_0_16px_rgba(56,189,248,0.4)] text-[#061A2E] font-extrabold text-sm tracking-wider font-display-title">
              MSAP
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-headline-sm text-white tracking-tight font-display-title">MSAP</span>
                <span className="font-label-caps text-[#38BDF8] px-1.5 py-0.5 rounded bg-[#103A5F] font-mono-code font-bold">2026</span>
              </div>
              <span className="font-label-md text-[#9DB8CF] hidden sm:inline">53rd Freshers' Meet Gala</span>
            </div>
          </div>

          <div className="hidden xl:flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#0C2C4A] border border-[#34D399]/30 shadow-[0_0_12px_rgba(52,211,153,0.15)]">
              <span className="w-2 h-2 rounded-full bg-[#34D399] animate-pulse"></span>
              <span className="font-label-md text-[#EAF6FF]">Apps Script Live Sync Engine</span>
            </div>
            <div className="flex items-center gap-2 text-[#9DB8CF] font-label-md">
              <span className="material-symbols-outlined text-[#38BDF8] text-[16px]">calendar_today</span>
              <span>02 OCT 2026</span>
              <span className="text-[#164468]">•</span>
              <span className="material-symbols-outlined text-[#38BDF8] text-[16px]">location_on</span>
              <span className="max-w-[240px] truncate">{eventSettings.venue}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setShowGoogleFormModal(true)}
              className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#0C2C4A] hover:bg-[#103A5F] text-[#38BDF8] border border-[#164468] transition-colors text-xs font-semibold cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">assignment</span>
              <span>Google Form Link</span>
            </button>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0C2C4A] text-[#38BDF8] border border-[#164468] text-xs">
              <span className="material-symbols-outlined text-[16px]">verified_user</span>
              <span className="hidden sm:inline">Official Ticketing</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#38BDF8] flex items-center justify-center shadow-[0_0_12px_rgba(56,189,248,0.4)] text-[#061A2E] font-bold text-xs">
              M26
            </div>
          </div>
        </div>
      </header>

      {/* ================= MAIN CONTENT ================= */}
      <main className="w-full pt-24 pb-16 min-h-[calc(100vh-140px)]">
        <div className="relative w-full overflow-hidden">
          {/* Ambient Glows */}
          <div className="absolute top-[-8rem] right-[-5rem] w-[42rem] h-[42rem] rounded-full bg-gradient-to-br from-[#0284C7]/20 via-[#38BDF8]/10 to-transparent blur-3xl pointer-events-none"></div>
          <div className="absolute top-[32rem] left-[-10rem] w-[36rem] h-[36rem] rounded-full bg-gradient-to-tr from-[#38BDF8]/15 via-[#0284C7]/10 to-transparent blur-3xl pointer-events-none"></div>
          <div className="absolute bottom-20 right-1/4 w-[30rem] h-[30rem] rounded-full bg-gradient-to-t from-[#FDBA74]/15 via-[#FDBA74]/5 to-transparent blur-3xl pointer-events-none"></div>

          <div className="max-w-7xl mx-auto px-5 lg:px-12 flex flex-col gap-10 relative z-10">
            {/* ================= 1. HERO HEADER ================= */}
            <section className="flex flex-col gap-4 items-start pt-4">
              <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#FDBA74]/15 text-[#FDBA74] border border-[#FDBA74]/30 shadow-[0_0_18px_rgba(253,186,116,0.25)]">
                <span className="material-symbols-outlined text-[16px] text-[#FDBA74]">stars</span>
                <span className="font-label-caps tracking-widest text-[#FDBA74] uppercase">53RD INDUCTION FESTIVAL • GENESIS GALA</span>
                <span className="w-1.5 h-1.5 rounded-full bg-[#FDBA74] animate-ping"></span>
              </div>

              <div className="flex flex-col gap-1">
                <h1 className="font-display-title font-display-hero tracking-tight bg-gradient-to-r from-[#EAF6FF] via-[#7DD3FC] to-[#38BDF8] bg-clip-text text-transparent">
                  MSAP 53rd Freshers' Meet 2026
                </h1>
              </div>

              {/* Event Metadata Pills */}
              <div className="flex flex-wrap items-center gap-3 w-full pt-1">
                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#38BDF8] text-[20px]">calendar_month</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">EVENT DATE</span>
                    <span className="font-label-lg text-[#EAF6FF]">02 OCT 2026</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#7DD3FC] text-[20px]">schedule</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">DOORS OPEN</span>
                    <span className="font-label-lg text-[#EAF6FF]">{eventSettings.time}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#FDBA74] text-[20px]">location_on</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">VENUE</span>
                    <span className="font-label-lg text-[#EAF6FF]">{eventSettings.venue}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] shadow-sm">
                  <span className="material-symbols-outlined text-[#34D399] text-[20px]">confirmation_number</span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-[#9DB8CF]">PASS TYPE</span>
                    <span className="font-label-lg text-[#EAF6FF]">All-Access Gala & Food Pass (₹{eventSettings.registrationPrice})</span>
                  </div>
                </div>
              </div>
            </section>

            {/* ================= 2. UNIFIED REGISTRATION & PAYMENT WORKFLOW ================= */}
            <section id="unifiedWorkflowCard" className="w-full max-w-4xl mx-auto flex flex-col gap-6">
              <div className="bg-[#0C2C4A]/95 backdrop-blur-2xl p-6 sm:p-8 rounded-3xl border border-[#164468] shadow-[0_20px_50px_rgba(6,26,46,0.8)] flex flex-col gap-6 relative">
                
                {/* CARD HEADER */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#164468]/70 pb-5">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-[#103A5F] text-[#38BDF8] font-label-caps font-bold text-[11px] tracking-wider">
                        OFFICIAL PORTAL
                      </span>
                      <h2 className="font-headline-md text-white font-display-title text-xl sm:text-2xl">
                        MSAP Freshers' Meet 2026
                      </h2>
                    </div>
                    <p className="font-body-sm text-[#9DB8CF]">
                      Unified Registration & Secure Payment Gateway • All-Access Entry & Food Pass (₹{eventSettings.registrationPrice})
                    </p>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-center">
                    <button
                      type="button"
                      onClick={() => setShowRetrieveDrawer((prev) => !prev)}
                      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
                        showRetrieveDrawer
                          ? 'bg-[#38BDF8] text-[#061A2E] border-[#38BDF8] shadow-[0_0_12px_rgba(56,189,248,0.3)]'
                          : 'bg-[#061A2E] hover:bg-[#103A5F] text-[#38BDF8] border-[#164468]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {showRetrieveDrawer ? 'close' : 'manage_search'}
                      </span>
                      <span>{showRetrieveDrawer ? 'Close Lookup' : 'Retrieve Existing Pass'}</span>
                    </button>
                    
                    <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#34D399]/15 border border-[#34D399]/30">
                      <span className="w-2 h-2 rounded-full bg-[#34D399] animate-pulse"></span>
                      <span className="font-label-caps text-[#34D399] font-bold text-[10px]">SECURE</span>
                    </div>
                  </div>
                </div>

                {/* RETRIEVE PASS DRAWER */}
                {showRetrieveDrawer && (
                  <div className="p-4 sm:p-5 rounded-2xl bg-[#061A2E] border border-[#38BDF8]/40 shadow-inner flex flex-col gap-3 animate-fadeIn">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[#38BDF8] text-[20px]">search</span>
                        <span className="font-label-caps text-[#38BDF8] uppercase tracking-wider text-xs font-bold">
                          RETRIEVE EXISTING REGISTRATION OR PASS
                        </span>
                      </div>
                      <span className="text-[11px] text-[#9DB8CF]">Instant lookup by Phone + Roll ID / Email</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
                      <input
                        className="sm:col-span-2 w-full bg-[#0C2C4A] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] placeholder:text-[#9DB8CF]/60 border border-[#164468] outline-none focus:border-[#38BDF8] text-xs"
                        placeholder="Registered mobile (e.g. 9876543210)"
                        type="tel"
                        value={searchPhone}
                        onChange={(e) => setSearchPhone(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchPass()}
                      />
                      <input
                        className="sm:col-span-2 w-full bg-[#0C2C4A] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] placeholder:text-[#9DB8CF]/60 border border-[#164468] outline-none focus:border-[#38BDF8] text-xs"
                        placeholder="Email or Student Roll ID"
                        type="text"
                        value={searchKey}
                        onChange={(e) => setSearchKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchPass()}
                      />
                      <button
                        onClick={handleSearchPass}
                        disabled={searchLoading}
                        className="sm:col-span-1 px-4 py-2.5 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] font-bold text-xs shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                        type="button"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {searchLoading ? 'progress_activity' : 'search'}
                        </span>
                        <span>{searchLoading ? 'Searching...' : 'Find Pass'}</span>
                      </button>
                    </div>

                    {searchMessage && (
                      <div className="text-xs p-2.5 rounded-xl bg-[#0C2C4A] border border-[#164468] text-[#EAF6FF] font-mono-code">
                        {searchMessage}
                      </div>
                    )}
                  </div>
                )}

                {/* STEPPER PROGRESS INDICATOR */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-1.5 rounded-2xl bg-[#061A2E] border border-[#164468]">
                  {/* Step 1 Pill */}
                  <button
                    type="button"
                    onClick={() => {
                      if (!isPaid) setCurrentStep(1);
                    }}
                    className={`flex items-center justify-between p-3.5 rounded-xl transition-all text-left ${
                      currentStep === 1
                        ? 'bg-gradient-to-r from-[#0284C7]/25 to-[#38BDF8]/15 border border-[#38BDF8]/50 shadow-[0_0_15px_rgba(56,189,248,0.2)]'
                        : 'bg-[#0C2C4A]/40 border border-transparent hover:border-[#164468] cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono-code font-bold text-xs ${
                        currentStep === 1
                          ? 'bg-[#38BDF8] text-[#061A2E] shadow-[0_0_10px_rgba(56,189,248,0.5)]'
                          : ticketData.registrationId
                          ? 'bg-[#34D399]/20 text-[#34D399] border border-[#34D399]/40'
                          : 'bg-[#103A5F] text-[#9DB8CF]'
                      }`}>
                        {ticketData.registrationId ? '✓' : '01'}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-label-caps text-[10px] text-[#9DB8CF] uppercase">STEP 01</span>
                        <span className="font-display-title font-bold text-sm text-white">Student Registration</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`text-[11px] font-mono-code font-semibold px-2 py-0.5 rounded-full ${
                        currentStep === 1
                          ? 'bg-[#38BDF8]/15 text-[#38BDF8]'
                          : ticketData.registrationId
                          ? 'bg-[#34D399]/15 text-[#34D399]'
                          : 'text-[#9DB8CF]'
                      }`}>
                        {currentStep === 1 ? 'ACTIVE' : ticketData.registrationId ? `✓ ${ticketData.registrationId}` : 'PENDING'}
                      </span>
                    </div>
                  </button>

                  {/* Step 2 Pill */}
                  <button
                    type="button"
                    onClick={() => {
                      if (ticketData.registrationId) setCurrentStep(2);
                    }}
                    disabled={!ticketData.registrationId}
                    className={`flex items-center justify-between p-3.5 rounded-xl transition-all text-left ${
                      currentStep === 2
                        ? 'bg-gradient-to-r from-[#0284C7]/25 to-[#38BDF8]/15 border border-[#38BDF8]/50 shadow-[0_0_15px_rgba(56,189,248,0.2)]'
                        : 'bg-[#0C2C4A]/40 border border-transparent hover:border-[#164468] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono-code font-bold text-xs ${
                        isPaid
                          ? 'bg-[#34D399] text-[#061A2E] shadow-[0_0_10px_rgba(52,211,153,0.5)]'
                          : currentStep === 2
                          ? 'bg-[#38BDF8] text-[#061A2E] shadow-[0_0_10px_rgba(56,189,248,0.5)]'
                          : 'bg-[#103A5F] text-[#9DB8CF]'
                      }`}>
                        {isPaid ? '✓' : '02'}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-label-caps text-[10px] text-[#9DB8CF] uppercase">STEP 02</span>
                        <span className="font-display-title font-bold text-sm text-white">Payment & Ticket Pass</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`text-[11px] font-mono-code font-semibold px-2 py-0.5 rounded-full ${
                        isPaid
                          ? 'bg-[#34D399]/15 text-[#34D399]'
                          : ticketData.paymentStatus === 'PAYMENT_SUBMITTED'
                          ? 'bg-[#FDBA74]/15 text-[#FDBA74]'
                          : ticketData.paymentStatus === 'REJECTED'
                          ? 'bg-[#FB7185]/15 text-[#FB7185]'
                          : currentStep === 2
                          ? 'bg-[#38BDF8]/15 text-[#38BDF8]'
                          : 'text-[#9DB8CF]'
                      }`}>
                        {isPaid
                          ? '✓ PASS ISSUED'
                          : ticketData.paymentStatus === 'PAYMENT_SUBMITTED'
                          ? '⏳ VERIFYING'
                          : ticketData.paymentStatus === 'REJECTED'
                          ? '⚠️ RESUBMIT'
                          : ticketData.registrationId
                          ? 'PAYMENT DUE'
                          : 'LOCKED'}
                      </span>
                    </div>
                  </button>
                </div>

                {/* ---------------------------------------------------- */}
                {/* STEP 1: REGISTRATION INTAKE FORM                    */}
                {/* ---------------------------------------------------- */}
                {currentStep === 1 && (
                  <form
                    id="registrationForm"
                    className="flex flex-col gap-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSubmitRegistration();
                    }}
                  >
                    {/* Header banner inside Step 1 */}
                    <div className="p-4 rounded-2xl bg-[#061A2E] border border-[#164468] flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="material-symbols-outlined text-[#38BDF8] text-[22px]">how_to_reg</span>
                        <span className="font-headline-sm text-white text-sm font-semibold">
                          Step 1 of 2: Attendee Credentials
                        </span>
                      </div>
                      <span className="text-xs font-mono-code text-[#38BDF8] font-bold">
                        Pass Fee: ₹{eventSettings.registrationPrice}
                      </span>
                    </div>

                    {/* Candidate Name */}
                    <div className="flex flex-col gap-1">
                      <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between text-xs">
                        <span>FULL CANDIDATE NAME</span>
                        <span className="text-[#FB7185]">*</span>
                      </label>
                      <div className="relative">
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-md text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="e.g. Ningthoujam Amarjit"
                          type="text"
                          value={inputName}
                          onChange={(e) => setInputName(e.target.value)}
                          required
                        />
                        <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-[20px]">
                          person
                        </span>
                      </div>
                    </div>

                    {/* Phone & Email */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between text-xs">
                          <span>WHATSAPP / MOBILE NUMBER</span>
                          <span className="text-[#FB7185]">*</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="e.g. 9876543210"
                          type="tel"
                          value={inputPhone}
                          onChange={(e) => setInputPhone(e.target.value)}
                          required
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between text-xs">
                          <span>LEARNER OFFICIAL EMAIL</span>
                          <span className="text-[#FB7185]">*</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="you@college.edu.in"
                          type="email"
                          value={inputEmail}
                          onChange={(e) => setInputEmail(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    {/* Roll ID & Department */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between text-xs">
                          <span>STUDENT / ROLL ID</span>
                          <span className="text-[#38BDF8] text-[10px] font-mono-code">(OPTIONAL FOR FRESHERS)</span>
                        </label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="e.g. 2026-ARCH-042 (if assigned)"
                          type="text"
                          value={inputRoll}
                          onChange={(e) => setInputRoll(e.target.value)}
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] text-xs">COLLEGE / DEPARTMENT</label>
                        <div className="relative">
                          <select
                            className="w-full bg-[#061A2E] px-3 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] appearance-none transition-all cursor-pointer text-sm"
                            value={inputDept}
                            onChange={(e) => setInputDept(e.target.value)}
                          >
                            <option value="" disabled>Select department</option>
                            <option value="B.Arch - Architecture">B.Arch - Architecture</option>
                            <option value="B.Des - Interior Design">B.Des - Interior Design</option>
                            <option value="B.Des - Fashion Design">B.Des - Fashion Design</option>
                            <option value="M.Plan - Urban Planning">M.Plan - Urban Planning</option>
                            <option value="Other University Affiliate">Other University Affiliate</option>
                          </select>
                          <span className="material-symbols-outlined absolute right-3 top-2.5 text-[#9DB8CF] text-[20px] pointer-events-none">
                            expand_more
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Course / Class & Academic Year */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] text-xs">COURSE / CLASS</label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="e.g. 1st Year B.Arch"
                          type="text"
                          value={inputCourseClass}
                          onChange={(e) => setInputCourseClass(e.target.value)}
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="font-label-caps text-[#9DB8CF] text-xs">ACADEMIC YEAR</label>
                        <input
                          className="w-full bg-[#061A2E] px-3.5 py-2.5 rounded-xl font-body-sm text-[#EAF6FF] border border-[#164468] outline-none focus:border-[#38BDF8] transition-all text-sm"
                          placeholder="e.g. 2026-2027"
                          type="text"
                          value={inputAcademicYear}
                          onChange={(e) => setInputAcademicYear(e.target.value)}
                        />
                      </div>
                    </div>

                    {/* Category Toggle: Fresher vs Senior */}
                    <div className="flex flex-col gap-1.5 pt-1">
                      <label className="font-label-caps text-[#9DB8CF] flex items-center justify-between text-xs">
                        <span>PARTICIPANT CATEGORY</span>
                        <span className="text-[#38BDF8] font-mono-code text-xs">WRISTBAND IDENTIFIER</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[#061A2E] border border-[#164468]">
                        <button
                          type="button"
                          onClick={() => setSelectedCohort('FRESHER')}
                          className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-label-lg transition-all font-semibold cursor-pointer text-xs ${
                            selectedCohort === 'FRESHER'
                              ? 'bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] shadow-md font-bold'
                              : 'bg-transparent text-[#9DB8CF] hover:text-[#EAF6FF] hover:bg-[#103A5F]'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[18px]">verified</span>
                          <span>FRESHER (2026)</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedCohort('SENIOR')}
                          className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg font-label-lg transition-all font-semibold cursor-pointer text-xs ${
                            selectedCohort === 'SENIOR'
                              ? 'bg-gradient-to-r from-[#38BDF8] to-[#7DD3FC] text-[#061A2E] shadow-md font-bold'
                              : 'bg-transparent text-[#9DB8CF] hover:text-[#EAF6FF] hover:bg-[#103A5F]'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[18px]">school</span>
                          <span>SENIOR HOST</span>
                        </button>
                      </div>
                    </div>

                    {/* Information Strip */}
                    <div className="p-3.5 rounded-xl bg-[#061A2E] border border-[#164468] flex items-start gap-2.5 text-xs text-[#9DB8CF]">
                      <span className="material-symbols-outlined text-[#38BDF8] text-[20px] shrink-0 mt-0.5">info</span>
                      <p className="leading-relaxed">
                        Submitting this form securely registers your details in the MSAP database. You will immediately proceed to <strong className="text-white">Step 2: Payment</strong> to scan the official UPI QR code and submit your transaction UTR to issue your verified pass.
                      </p>
                    </div>

                    {formSuccessMessage && (
                      <div className="p-3 rounded-xl bg-[#34D399]/15 border border-[#34D399]/40 text-[#34D399] text-xs font-semibold">
                        {formSuccessMessage}
                      </div>
                    )}

                    {formErrorMessage && (
                      <div className="p-3 rounded-xl bg-[#FB7185]/15 border border-[#FB7185]/40 text-[#FB7185] text-xs font-semibold">
                        {formErrorMessage}
                      </div>
                    )}

                    {/* Submit Button */}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full mt-2 flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#38BDF8] to-[#7DD3FC] text-[#061A2E] font-headline-sm text-base shadow-[0_0_24px_rgba(56,189,248,0.35)] hover:shadow-[0_0_32px_rgba(56,189,248,0.55)] hover:scale-[1.005] active:scale-[0.995] transition-all cursor-pointer font-bold disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        {submitting ? 'progress_activity' : 'arrow_forward'}
                      </span>
                      <span>{submitting ? 'Saving Registration...' : `Continue to Secure Payment (₹${eventSettings.registrationPrice})`}</span>
                    </button>
                  </form>
                )}

                {/* ---------------------------------------------------- */}
                {/* STEP 2: PAYMENT & PASS UNLOCKING                    */}
                {/* ---------------------------------------------------- */}
                {currentStep === 2 && (
                  <div className="flex flex-col gap-5">
                    {/* Attendee Summary Strip */}
                    <div className="p-4 rounded-2xl bg-[#061A2E] border border-[#164468] flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-[#103A5F] flex items-center justify-center text-[#38BDF8] font-bold">
                          <span className="material-symbols-outlined text-[20px]">badge</span>
                        </div>
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-sm">{ticketData.fullName || 'Candidate'}</span>
                            <span className="px-1.5 py-0.5 rounded bg-[#103A5F] text-[#38BDF8] font-mono-code font-bold text-[10px]">
                              {ticketData.category}
                            </span>
                          </div>
                          <span className="text-[#9DB8CF] font-mono-code text-[11px]">
                            Reg ID: <strong className="text-[#38BDF8]">{ticketData.registrationId || 'REG-PENDING'}</strong>
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <span className="text-[10px] font-mono-code text-[#9DB8CF] block uppercase">AMOUNT DUE</span>
                          <span className="font-mono-code font-bold text-emerald-400 text-sm">₹{eventSettings.registrationPrice}</span>
                        </div>

                        {!isPaid && ticketData.paymentStatus !== 'PAYMENT_SUBMITTED' && (
                          <button
                            type="button"
                            onClick={() => setCurrentStep(1)}
                            className="px-2.5 py-1.5 rounded-lg bg-[#0C2C4A] hover:bg-[#103A5F] text-[#9DB8CF] hover:text-white border border-[#164468] transition-colors text-xs font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[14px]">edit</span>
                            <span>Edit Details</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* STATE 2A: PAID & VERIFIED -> UNLOCKED MASTER TICKET */}
                    {isPaid ? (
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[#34D399] text-[22px]">verified</span>
                            <span className="font-label-caps text-[#34D399] tracking-widest uppercase font-bold">
                              OFFICIAL MASTER ENTRY TICKET UNLOCKED
                            </span>
                          </div>

                          <div className="px-3 py-1 rounded-full bg-[#34D399]/15 text-[#34D399] border border-[#34D399]/40 font-mono-code font-bold text-xs flex items-center gap-1.5 shadow-[0_0_12px_rgba(52,211,153,0.25)]">
                            <span className="w-2 h-2 rounded-full bg-[#34D399] animate-ping"></span>
                            <span>{ticketData.checkInStatus === 'CHECKED_IN' ? 'CHECKED IN (ENTRY USED)' : 'PASS ACTIVE FOR ENTRY'}</span>
                          </div>
                        </div>

                        {/* Master Ticket Canvas Container */}
                        <div id="digitalTicketCard" className="w-full">
                          <MasterTicketCanvas
                            ticketId={ticketData.ticketId || 'FM26-001'}
                            category={ticketData.category}
                            qrToken={ticketData.qrToken}
                            qrDataUrl={ticketData.qrDataUrl}
                            qrSvg={ticketData.qrSvg}
                            fullName={ticketData.fullName}
                          />
                        </div>

                        {/* Action Buttons: Download, Wallet, Share */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <button
                            type="button"
                            onClick={handleDownloadTicket}
                            disabled={downloading}
                            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-[#0284C7] to-[#38BDF8] text-[#061A2E] font-bold text-xs shadow-md transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              {downloading ? 'progress_activity' : 'download'}
                            </span>
                            <span>{downloading ? 'Generating PNG...' : 'Download Pass (PNG)'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleShareWhatsApp}
                            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-[#25D366]/20 hover:bg-[#25D366]/30 text-[#25D366] border border-[#25D366]/40 font-bold text-xs transition-all cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[18px]">share</span>
                            <span>Share on WhatsApp</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleAddToWallet}
                            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-[#061A2E] hover:bg-[#103A5F] text-[#EAF6FF] border border-[#164468] font-bold text-xs transition-all cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[18px]">wallet</span>
                            <span>{walletAdded ? 'Added to Wallet!' : 'Add to Wallet'}</span>
                          </button>
                        </div>

                        {/* Verified Attendee Metadata Strip */}
                        <div className="p-4 rounded-2xl bg-[#061A2E] border border-[#164468] grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">ATTENDEE</span>
                            <span className="font-bold text-white text-sm truncate">{ticketData.fullName}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">REGISTRATION ID</span>
                            <span className="font-mono-code font-bold text-[#38BDF8] text-sm">{ticketData.registrationId || 'REG-????'}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">TICKET NUMBER</span>
                            <span className="font-mono-code font-bold text-[#34D399] text-sm">{ticketData.ticketId}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[10px] font-mono-code text-[#9DB8CF] uppercase">CHECK-IN STATUS</span>
                            <span className={`font-mono-code font-bold text-xs ${ticketData.checkInStatus === 'CHECKED_IN' ? 'text-[#34D399]' : 'text-[#38BDF8]'}`}>
                              {ticketData.checkInStatus === 'CHECKED_IN' ? 'CHECKED IN' : 'VALID & UNUSED'}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2">
                          <button
                            type="button"
                            onClick={handleNewRegistration}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#103A5F] hover:bg-[#164468] text-[#38BDF8] border border-[#164468] text-xs font-semibold cursor-pointer transition-colors"
                          >
                            <span className="material-symbols-outlined text-[16px]">person_add</span>
                            <span>Register Another Student</span>
                          </button>
                          <span className="text-[11px] text-[#9DB8CF] font-mono-code">
                            Gate Turnstile 01 Compatible
                          </span>
                        </div>
                      </div>
                    ) : (
                      /* STATE 2B: SECURE AUTOMATIC PAYMENT VIA RAZORPAY */
                      <div className="p-6 sm:p-8 rounded-2xl bg-[#061A2E] border border-[#164468] shadow-2xl flex flex-col gap-6">
                        {/* Section Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#164468]/60 pb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#0284C7] to-[#38BDF8] flex items-center justify-center text-[#061A2E] font-bold shadow-[0_0_15px_rgba(56,189,248,0.4)]">
                              <span className="material-symbols-outlined text-2xl">lock</span>
                            </div>
                            <div>
                              <h3 className="font-display-title font-bold text-white text-lg sm:text-xl">
                                Official Secure Payment
                              </h3>
                              <p className="text-xs text-[#9DB8CF]">
                                Powered by Razorpay • Instant Master Ticket generation upon verification
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 self-start sm:self-center">
                            <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase">TOTAL PAYABLE:</span>
                            <span className="px-3.5 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 font-mono-code font-bold text-lg border border-emerald-500/30 shadow-[0_0_12px_rgba(52,211,153,0.2)]">
                              ₹{eventSettings.registrationPrice}
                            </span>
                          </div>
                        </div>

                        {/* Order & Candidate Breakdown Card */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-[#0C2C4A] p-4 rounded-xl border border-[#164468]">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[#9DB8CF] font-mono-code text-[10px] uppercase">REGISTRATION ID</span>
                            <span className="font-mono-code font-bold text-[#38BDF8] text-sm">{ticketData.registrationId || 'REG-PENDING'}</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[#9DB8CF] font-mono-code text-[10px] uppercase">NAME</span>
                            <span className="font-bold text-white text-sm truncate">{ticketData.fullName || 'Candidate'}</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[#9DB8CF] font-mono-code text-[10px] uppercase">CATEGORY</span>
                            <span className="font-mono-code font-bold text-white text-sm">{ticketData.category}</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[#9DB8CF] font-mono-code text-[10px] uppercase">EVENT PASS</span>
                            <span className="font-semibold text-emerald-400 text-sm">Gala & Food (₹{eventSettings.registrationPrice})</span>
                          </div>
                        </div>

                        {/* Supported Payment Methods Ribbon */}
                        <div className="flex flex-col gap-2 p-4 rounded-xl bg-[#0C2C4A]/60 border border-[#164468]">
                          <span className="text-[11px] font-mono-code text-[#9DB8CF] uppercase tracking-wider font-bold">
                            ACCEPTED PAYMENT METHODS
                          </span>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <span className="px-3 py-1.5 rounded-lg bg-[#061A2E] text-[#EAF6FF] text-xs font-semibold border border-[#164468] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#34D399]"></span>
                              Google Pay
                            </span>
                            <span className="px-3 py-1.5 rounded-lg bg-[#061A2E] text-[#EAF6FF] text-xs font-semibold border border-[#164468] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#38BDF8]"></span>
                              PhonePe
                            </span>
                            <span className="px-3 py-1.5 rounded-lg bg-[#061A2E] text-[#EAF6FF] text-xs font-semibold border border-[#164468] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#0284C7]"></span>
                              Paytm
                            </span>
                            <span className="px-3 py-1.5 rounded-lg bg-[#061A2E] text-[#EAF6FF] text-xs font-semibold border border-[#164468] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#FDBA74]"></span>
                              BHIM / Any UPI
                            </span>
                            <span className="px-3 py-1.5 rounded-lg bg-[#061A2E] text-[#EAF6FF] text-xs font-semibold border border-[#164468] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#9DB8CF]"></span>
                              Debit / Credit Cards & NetBanking
                            </span>
                          </div>
                        </div>

                        {/* Live Status Message / Processing Banner */}
                        {onlinePayLoading && (
                          <div className="p-4 rounded-xl bg-[#0C2C4A] border border-[#38BDF8]/40 flex items-center gap-3 animate-pulse">
                            <span className="material-symbols-outlined text-[#38BDF8] text-2xl animate-spin">progress_activity</span>
                            <div className="flex flex-col">
                              <span className="font-bold text-white text-sm">Payment processing…</span>
                              <span className="text-xs text-[#9DB8CF]">Please complete the payment in the payment window.</span>
                            </div>
                          </div>
                        )}

                        {paymentMessage && !onlinePayLoading && (
                          <div className={`p-3.5 rounded-xl border text-xs font-mono-code flex items-center gap-2.5 ${
                            paymentMessage.startsWith('❌')
                              ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                              : paymentMessage.startsWith('✓')
                              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                              : 'bg-[#0C2C4A] border-[#164468] text-[#EAF6FF]'
                          }`}>
                            <span className={`material-symbols-outlined text-base ${
                              paymentMessage.startsWith('❌')
                                ? 'text-rose-400'
                                : paymentMessage.startsWith('✓')
                                ? 'text-emerald-400'
                                : 'text-[#38BDF8]'
                            }`}>
                              {paymentMessage.startsWith('❌') ? 'error' : paymentMessage.startsWith('✓') ? 'check_circle' : 'info'}
                            </span>
                            <span>{paymentMessage}</span>
                          </div>
                        )}

                        {/* Main Payment CTA Button */}
                        <div className="flex flex-col gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleOnlinePayment}
                            disabled={onlinePayLoading}
                            className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#38BDF8] to-[#7DD3FC] text-[#061A2E] font-extrabold text-base shadow-[0_0_30px_rgba(56,189,248,0.4)] hover:shadow-[0_0_40px_rgba(56,189,248,0.6)] hover:scale-[1.005] active:scale-[0.995] transition-all cursor-pointer flex items-center justify-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className={`material-symbols-outlined text-xl ${onlinePayLoading ? 'animate-spin' : ''}`}>
                              {onlinePayLoading ? 'progress_activity' : 'payments'}
                            </span>
                            <span>
                              {onlinePayLoading
                                ? 'Opening Payment Window...'
                                : paymentMessage && (paymentMessage.includes('failed') || paymentMessage.includes('closed') || paymentMessage.includes('declined') || paymentMessage.startsWith('❌'))
                                ? `Try Payment Again (₹${eventSettings.registrationPrice})`
                                : `Pay ₹${eventSettings.registrationPrice} & Unlock Master Pass`}
                            </span>
                          </button>
                        </div>

                        {/* Security Footer */}
                        <div className="p-3.5 rounded-xl bg-[#0C2C4A]/50 border border-[#164468]/60 flex items-center justify-between text-[#9DB8CF] text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[#34D399] text-base">verified_user</span>
                            <span>End-to-End 256-Bit SSL Encrypted</span>
                          </div>
                          <span className="hidden sm:inline font-mono-code text-[10px]">Authoritative Gateway Verification</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* ================= 3. BACKEND ZERO-LATENCY PIPELINE ================= */}
            <section className="flex flex-col gap-6 pt-6 border-t border-[#164468]/60">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#38BDF8]"></span>
                  <span className="font-label-caps text-[#38BDF8] uppercase">ZERO-LATENCY ARCHITECTURE</span>
                </div>
                <h2 className="font-headline-lg text-white tracking-tight font-display-title">
                  Automated Verification & Live Scanner Pipeline
                </h2>
              </div>

      

              {/* ================= 4. GENESIS EXPERIENCE HIGHLIGHTS ================= */}
              <div className="flex flex-col gap-4 pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-headline-md text-white font-display-title">Genesis Experience Highlights</h3>
                  <span className="font-label-caps text-[#FDBA74] tracking-wider uppercase">02 OCT LINEUP</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Campus DJ Stage"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#FB7185] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        HEADLINER ACT
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Main Arena DJ & Kinetic Beats</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        High-octane electro set featuring guest alumni producers with acoustic surround mapping in Pune Auditorium.
                      </p>
                    </div>
                  </div>

                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Parametric Architecture Pavilion"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#FDBA74] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        DESIGN PAVILION
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Parametric Neon Photo Portals</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        Crafted by senior architecture studios: interactive luminescence structures designed for cohort portraits.
                      </p>
                    </div>
                  </div>

                  <div className="group relative rounded-2xl overflow-hidden bg-[#0C2C4A] border border-[#164468] flex flex-col">
                    <div className="h-44 w-full relative overflow-hidden bg-[#061A2E]">
                      <img
                        alt="Campus Food and Mocktail Garden"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        src="https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=800&q=80"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0C2C4A] via-[#0C2C4A]/40 to-transparent"></div>
                      <div className="absolute top-3 right-3 px-2.5 py-0.5 rounded-full bg-[#38BDF8] text-[#061A2E] font-label-caps shadow-sm font-bold">
                        CULINARY OASIS
                      </div>
                    </div>
                    <div className="p-4 flex flex-col gap-1">
                      <h4 className="font-headline-sm text-white font-display-title">Gourmet Treats & Mocktail Garden</h4>
                      <p className="font-body-sm text-[#9DB8CF]">
                        Complimentary artisan welcome sips, wood-fired bites, and sweet treats included in your current gala pass.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* ================= GOOGLE FORM MODAL ================= */}
      {showGoogleFormModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0C2C4A] border border-[#164468] rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#164468] pb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#38BDF8]">description</span>
                <h3 className="font-headline-sm text-white">Google Form Integration</h3>
              </div>
              <button
                onClick={() => setShowGoogleFormModal(false)}
                className="text-[#9DB8CF] hover:text-[#EAF6FF] cursor-pointer"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="text-sm text-[#9DB8CF] flex flex-col gap-3 leading-relaxed">
              <p>
                Student registrations can be submitted through the official <strong className="text-white">MSAP Google Form</strong>. Responses flow directly into <strong className="text-white">Google Sheets</strong>, where our <strong className="text-white">Google Apps Script Webhook</strong> synchronizes each entry into the MySQL backend.
              </p>
              <div className="p-3 rounded-xl bg-[#061A2E] border border-[#164468] flex flex-col gap-1 font-mono-code text-xs">
                <span className="text-[#38BDF8]">Google Form Fields:</span>
                <span className="text-[#9DB8CF]">• Full Candidate Name</span>
                <span className="text-[#9DB8CF]">• WhatsApp / Mobile Number</span>
                <span className="text-[#9DB8CF]">• Learner Email Address</span>
                <span className="text-[#9DB8CF]">• Student / Roll ID & Department</span>
                <span className="text-[#9DB8CF]">• Category: Fresher vs Senior</span>
                <span className="text-[#9DB8CF]">• Online Payment Confirmation</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowGoogleFormModal(false)}
                className="px-4 py-2 rounded-xl bg-[#103A5F] hover:bg-[#164468] text-[#EAF6FF] text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setShowGoogleFormModal(false);
                  const regEl = document.getElementById('registrationForm');
                  if (regEl) regEl.scrollIntoView({ behavior: 'smooth' });
                }}
                className="px-4 py-2 rounded-xl bg-[#38BDF8] hover:bg-[#7DD3FC] text-[#061A2E] text-xs font-bold cursor-pointer transition-colors"
              >
                Use Quick On-Page Intake
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= FOOTER ================= */}
      <footer className="w-full bg-[#061A2E] border-t border-[#164468]/60 py-8">
        <div className="max-w-7xl mx-auto px-5 lg:px-12 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start gap-1">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-white tracking-tight font-display-title">
                MSAP 53rd Freshers' Meet 2026
              </span>
              <span className="px-2 py-0.5 rounded-full bg-[#103A5F] font-mono-code text-[11px] text-[#FDBA74] font-bold">
                VOUCHER ENGINE V3.0
              </span>
            </div>
            <p className="font-body-sm text-[#9DB8CF] text-center md:text-left">
              Manipur Students' Association Pune (MSAP) • 02 OCT 2026 • Pune Campus
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0C2C4A] border border-[#164468]">
              <span className="material-symbols-outlined text-[#34D399] text-[16px]">sync_saved_locally</span>
              <span className="font-label-md text-white">Apps Script Live Sync Engine Active</span>
            </div>
            <span className="font-label-md text-[#9DB8CF]">© 2026 MSAP Student Council. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
