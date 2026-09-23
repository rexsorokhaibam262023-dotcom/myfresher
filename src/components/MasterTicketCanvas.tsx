import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface MasterTicketCanvasProps {
  ticketId: string;
  category: string;
  qrToken?: string | null;
  qrDataUrl?: string;
  qrSvg?: string;
  fullName?: string;
  onDownloaded?: () => void;
}

export const MasterTicketCanvas: React.FC<MasterTicketCanvasProps> = ({
  ticketId,
  category,
  qrToken,
  qrDataUrl: initialQrDataUrl,
  fullName,
  onDownloaded,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderedDataUrl, setRenderedDataUrl] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState<boolean>(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);

  useEffect(() => {
    let isCancelled = false;

    async function drawTicket() {
      setIsRendering(true);
      setRenderError(null);

      try {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('HTML5 Canvas is not supported in this browser.');

        canvas.width = 1024;
        canvas.height = 443;

        // 1. Load Master Ticket Template Image
        const templateImg = new Image();
        templateImg.crossOrigin = 'anonymous';

        await new Promise<void>((resolve, reject) => {
          templateImg.onload = () => resolve();
          templateImg.onerror = () => reject(new Error('Failed to load master ticket template.'));
          templateImg.src = '/master-ticket-template.jpg';
        });

        if (isCancelled) return;

        // Draw template as background (1024 x 443)
        ctx.drawImage(templateImg, 0, 0, 1024, 443);

        // 2. Resolve QR Image DataURL
        let resolvedQrUrl = initialQrDataUrl;
        if (!resolvedQrUrl && qrToken) {
          try {
            resolvedQrUrl = await QRCode.toDataURL(qrToken, {
              margin: 1,
              width: 300,
              color: {
                dark: '#0B0F19',
                light: '#FFFFFF',
              },
              errorCorrectionLevel: 'H',
            });
          } catch (e) {
            console.warn('Could not generate QR code locally:', e);
          }
        }

        // 3. Draw QR code onto the ticket stub QR spot
        // Coordinates in template: x=805, y=136, width=122, height=122
        if (resolvedQrUrl) {
          const qrImg = new Image();
          await new Promise<void>((resolve) => {
            qrImg.onload = () => {
              // Draw crisp white backing box
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(803, 134, 124, 124);
              // Draw QR code image
              ctx.drawImage(qrImg, 804, 135, 122, 122);
              resolve();
            };
            qrImg.onerror = () => resolve();
            qrImg.src = resolvedQrUrl;
          });
        }

        if (isCancelled) return;

        // 4. Clean and overlay TICKET NO. value (at x=838, y=334)
        const cleanTicketId = String(ticketId || 'FM26-???').trim();
        // Clear value region with white card background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(835, 320, 130, 20);

        ctx.fillStyle = '#0F172A';
        ctx.font = 'bold 13.5px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(cleanTicketId, 838, 331);

        // 5. Clean and overlay CATEGORY value (at x=838, y=364)
        const cleanCategory = category === 'SENIOR' ? 'SENIOR' : 'FRESHER';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(835, 350, 130, 20);

        ctx.fillStyle = cleanCategory === 'SENIOR' ? '#0284C7' : '#D97706';
        ctx.font = 'bold 13px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(cleanCategory, 838, 361);

        const cleanFullName = String(fullName || '').trim();
        if (cleanFullName) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.fillRect(84, 300, 430, 38);

          ctx.fillStyle = '#0F172A';
          ctx.font = 'bold 22px "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const maxWidth = 400;
          let displayName = cleanFullName.toUpperCase();
          while (ctx.measureText(displayName).width > maxWidth && displayName.length > 4) {
            displayName = `${displayName.slice(0, -4).trim()}...`;
          }
          ctx.fillText(displayName, 92, 319);
        }

        // Export data URL for fallback image display
        const url = canvas.toDataURL('image/png', 1.0);
        setRenderedDataUrl(url);
      } catch (err: unknown) {
        console.error('Master ticket compositing error:', err);
        setRenderError(err instanceof Error ? err.message : 'Error rendering master ticket.');
      } finally {
        if (!isCancelled) {
          setIsRendering(false);
        }
      }
    }

    drawTicket();

    return () => {
      isCancelled = true;
    };
  }, [ticketId, category, qrToken, initialQrDataUrl, fullName]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setDownloading(true);
    try {
      const dataUrl = renderedDataUrl || canvas.toDataURL('image/png', 1.0);
      const link = document.createElement('a');
      link.download = `MSAP-53rd-Ticket-${ticketId || 'FM26'}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      if (onDownloaded) onDownloaded();
    } catch (err) {
      console.error('Download failed, using print fallback:', err);
      window.print();
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Hidden high-res canvas used for rendering and export */}
      <div className="relative rounded-2xl overflow-hidden border border-[#164468] shadow-[0_20px_50px_rgba(0,0,0,0.85)] bg-[#061A2E]">
        <canvas
          ref={canvasRef}
          width={1024}
          height={443}
          className="w-full h-auto block select-none"
          style={{ imageRendering: 'auto' }}
        />

        {isRendering && (
          <div className="absolute inset-0 bg-[#061A2E]/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2 text-[#38BDF8]">
            <span className="material-symbols-outlined text-3xl animate-spin">progress_activity</span>
            <span className="font-mono-code text-xs">Compositing Official Master Ticket...</span>
          </div>
        )}

        {renderError && (
          <div className="absolute inset-0 bg-[#FB7185]/20 backdrop-blur-sm p-4 flex flex-col items-center justify-center text-center text-[#FB7185] text-xs">
            <span className="material-symbols-outlined text-2xl mb-1">error</span>
            <span>{renderError}</span>
          </div>
        )}
      </div>

      {/* Action Buttons Below Master Ticket */}
      <div className="flex flex-col sm:flex-row items-center gap-2 w-full">
        <button
          onClick={handleDownload}
          disabled={downloading || isRendering}
          className="w-full sm:flex-1 py-3.5 px-5 rounded-xl bg-gradient-to-r from-[#0284C7] via-[#38BDF8] to-[#7DD3FC] text-[#061A2E] font-bold text-sm shadow-[0_0_24px_rgba(56,189,248,0.4)] hover:shadow-[0_0_32px_rgba(56,189,248,0.6)] hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          type="button"
        >
          <span className="material-symbols-outlined text-xl">
            {downloading ? 'progress_activity' : 'download'}
          </span>
          <span>{downloading ? 'Exporting Ticket...' : 'Download Official Ticket (PNG)'}</span>
        </button>

        <button
          onClick={() => {
            const text = encodeURIComponent(
              `🎟️ My official pass for MSAP 53rd Freshers' Meet 2026 is confirmed!\n\n` +
              `Ticket ID: ${ticketId}\n` +
              `Category: ${category}\n` +
              `Date: 02 OCT 2026\nVenue: Pune\n\n` +
              `See you at the Gala!`
            );
            window.open(`https://wa.me/?text=${text}`, '_blank');
          }}
          className="w-full sm:w-auto py-3.5 px-4 rounded-xl bg-[#0C2C4A] hover:bg-[#103A5F] text-[#34D399] border border-[#164468] text-xs font-semibold transition-colors cursor-pointer flex items-center justify-center gap-2"
          type="button"
        >
          <span className="material-symbols-outlined text-lg">share</span>
          <span>WhatsApp</span>
        </button>
      </div>
    </div>
  );
};
