import React, { useState, useEffect, useCallback, useLayoutEffect } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Wifi, Copy, RefreshCw, Info, Link } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { resolveBackendUrl } from "../utils/network";
import useToast from '../hooks/useToast';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('QRCode');

const animationDuration = 220;

const QRCodeDialog = ({ isOpen, onClose, darkMode }) => {
  logger.info('QRCodeDialog mounted', { isOpen });
  const [localIP, setLocalIP] = useState('');
  const [allIPs, setAllIPs] = useState({ lan: [], tailnet: [], all: [] });
  const [qrCodeDataURL, setQRCodeDataURL] = useState('');
  const [isGenerating, setIsGenerating] = useState(true);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [entering, setEntering] = useState(false);
  const [qrError, setQrError] = useState(false);

  const [joinCode, setJoinCode] = useState(null);
  const { showToast } = useToast();

  const port = import.meta.env.DEV ? '5174' : '4000';
  const urlBase = `http://${localIP}:${port}/`;

  const refreshJoinCode = useCallback(async () => {
    try {
      if (window.electronAPI?.getJoinCode) {
        const code = await window.electronAPI.getJoinCode();
        if (code) {
          setJoinCode(code);
          return;
        }
      }

      const response = await fetch(resolveBackendUrl('/api/auth/join-code'));
      if (!response.ok) {
        throw new Error(`Failed to fetch join code: ${response.status}`);
      }
      const payload = await response.json();
      setJoinCode(payload?.joinCode || null);
    } catch (error) {
      console.warn('Failed to load join code for QR dialog', error);
    }
  }, [resolveBackendUrl]);
  useEffect(() => {
    if (isOpen) {
      refreshJoinCode();
    }
  }, [isOpen, refreshJoinCode]);

  useEffect(() => {
    const handleJoinCodeUpdated = (event) => {
      const nextCode = event?.detail?.joinCode;
      if (typeof nextCode === 'string') {
        setJoinCode(nextCode);
      } else {
        setJoinCode(null);
        if (isOpen) {
          refreshJoinCode();
        }
      }
    };

    window.addEventListener('join-code-updated', handleJoinCodeUpdated);
    return () => window.removeEventListener('join-code-updated', handleJoinCodeUpdated);
  }, [isOpen, refreshJoinCode]);

  useEffect(() => {
    if (!isOpen) return;

    const getLocalIP = async () => {
      try {
        if (window.electronAPI?.getLocalIPs) {
          const res = await window.electronAPI.getLocalIPs();
          const list = res?.all || [...(res?.lan || []), ...(res?.tailnet || [])];
          setAllIPs({ lan: res?.lan || [], tailnet: res?.tailnet || [], all: list });
          const first = list[0]?.address || list[0];
          if (first) {
            setLocalIP(typeof first === 'string' ? first : first.address);
            return;
          }
        }
        if (window.electronAPI && window.electronAPI.getLocalIP) {
          const ip = await window.electronAPI.getLocalIP();
          setLocalIP(ip);
        } else {
          setLocalIP('localhost');
        }
      } catch (error) {
        console.error('Error getting local IP:', error);
        setLocalIP('localhost');
      }
    };

    getLocalIP();
  }, [isOpen]);

  useEffect(() => {
    if (!localIP || !isOpen || !joinCode) return;

    setQrError(false);
    const generateQRCode = async () => {
      setIsGenerating(true);

      try {
        const url = `${urlBase}?client=mobile&joinCode=${joinCode}`;

        const dataURL = await QRCode.toDataURL(url, {
          width: 220,
          margin: 2,
          color: {
            dark: darkMode ? '#FFFFFF' : '#000000',
            light: darkMode ? '#1F2937' : '#FFFFFF'
          },
          errorCorrectionLevel: 'M'
        });

        setQRCodeDataURL(dataURL);
      } catch (error) {
        console.error('Error generating QR code:', error);
        setQrError(true);
      } finally {
        setIsGenerating(false);
      }
    };

    generateQRCode();
  }, [localIP, isOpen, darkMode, joinCode]);


  useLayoutEffect(() => {
    if (isOpen) {
      setVisible(true);
      setExiting(false);
      setEntering(true);
      const raf = requestAnimationFrame(() => setEntering(false));
      return () => cancelAnimationFrame(raf);
    }

    if (!visible) {
      return undefined;
    }

    setEntering(false);
    setExiting(true);
    const timeout = setTimeout(() => {
      setExiting(false);
      setVisible(false);
    }, animationDuration);

    return () => clearTimeout(timeout);
  }, [isOpen, visible]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!visible) return null;

  const connectionURL = `${urlBase}?client=mobile`;
  const liteURL = `${urlBase}#/lite`;

  const topMenuHeight = typeof document !== 'undefined'
    ? (getComputedStyle(document.body).getPropertyValue('--top-menu-height')?.trim() || '0px')
    : '0px';

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast({
        title: 'Copied',
        message: `${label} copied to clipboard`,
        variant: 'success',
        duration: 2000,
      });
    }).catch(() => {
      showToast({
        title: 'Copy failed',
        message: `Could not copy ${label.toLowerCase()}`,
        variant: 'error',
      });
    });
  };

  const copyAllConnectionInfo = () => {
    const text = [
      'Selah Mobile Controller',
      `URL: ${connectionURL}`,
      joinCode ? `Join Code: ${joinCode}` : null,
    ].filter(Boolean).join('\n');
    copyToClipboard(text, 'Connection info');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ top: topMenuHeight }}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ${(exiting || entering) ? 'opacity-0' : 'opacity-100'}`}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect Mobile Controller"
        className={`
        relative w-full max-w-md mx-4 rounded-2xl border shadow-2xl ring-1 p-6
        ${darkMode ? 'bg-[#1A1C40] text-gray-50 border-[#282946] ring-[#7DDBD3]/20' : 'bg-white text-gray-900 border-gray-200 ring-blue-500/20'}
        transition-all duration-200 ease-out
        ${(exiting || entering) ? 'opacity-0 translate-y-8 scale-95' : 'opacity-100 translate-y-0 scale-100'}
      `}>

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Smartphone className="w-6 h-6" />
            Connect Mobile Controller
          </h2>
          <Button
            onClick={onClose}
            variant="ghost"
            size="icon"
            className={darkMode ? 'hover:bg-[#282946]' : 'hover:bg-gray-100'}
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="text-center space-y-4">

          {/* QR Code */}
          <div className={`
            mx-auto w-[220px] h-[220px] flex items-center justify-center rounded-lg border
            ${darkMode ? 'border-[#282946] bg-[#111231]' : 'border-gray-200 bg-gray-50'}
          `}>
            {isGenerating ? (
              <div className="flex flex-col items-center gap-2">
                <Wifi className={`w-8 h-8 animate-pulse ${darkMode ? 'text-[#55464B]' : 'text-gray-500'}`} />
                <span className={`text-sm ${darkMode ? 'text-[#55464B]' : 'text-gray-500'}`}>
                  Generating QR Code...
                </span>
              </div>
            ) : qrError ? (
              <div className="flex flex-col items-center gap-3 px-4">
                <div className={`
                  w-12 h-12 rounded-full flex items-center justify-center
                  ${darkMode ? 'bg-[#E06C75]/10' : 'bg-red-50'}
                `}>
                  <Info className={`w-6 h-6 ${darkMode ? 'text-[#E06C75]' : 'text-red-500'}`} />
                </div>
                <span className={`text-sm font-medium ${darkMode ? 'text-[#D8DEE0]' : 'text-gray-700'}`}>
                  Could not generate QR code
                </span>
                <span className={`text-xs ${darkMode ? 'text-[#55464B]' : 'text-gray-500'}`}>
                  You can enter this URL manually:
                </span>
                <div className={`
                  w-full px-3 py-2 rounded-md text-xs font-mono break-all text-left
                  ${darkMode ? 'bg-[#282946] text-[#D8DEE0]' : 'bg-gray-100 text-gray-800'}
                `}>
                  {connectionURL}
                </div>
                <Button
                  onClick={() => {
                    setQrError(false);
                    setIsGenerating(true);
                    const url = `${urlBase}?client=mobile&joinCode=${joinCode}`;
                    QRCode.toDataURL(url, {
                      width: 220,
                      margin: 2,
                      color: {
                        dark: darkMode ? '#FFFFFF' : '#000000',
                        light: darkMode ? '#1F2937' : '#FFFFFF'
                      },
                      errorCorrectionLevel: 'M'
                    }).then((dataURL) => {
                      setQRCodeDataURL(dataURL);
                      setQrError(false);
                    }).catch(() => {
                      setQrError(true);
                    }).finally(() => {
                      setIsGenerating(false);
                    });
                  }}
                  variant="outline"
                  size="sm"
                  className={`
                    gap-1.5 text-xs
                    ${darkMode
                      ? 'border-[#282946] text-[#D8DEE0] hover:bg-[#282946]'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-100'
                    }
                  `}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry
                </Button>
              </div>
            ) : qrCodeDataURL ? (
              <img
                src={qrCodeDataURL}
                alt="QR Code for mobile connection"
                className="w-[200px] h-[200px] rounded"
              />
            ) : null}
          </div>

          {/* Instructions */}
          <div className="space-y-3">
            <ol className={`
              text-sm text-left space-y-1.5 mx-auto max-w-[280px]
              ${darkMode ? 'text-[#D8DEE0]' : 'text-gray-700'}
            `}>
              <li className="flex gap-2">
                <span className={`font-semibold shrink-0 ${darkMode ? 'text-[#82AAFF]' : 'text-blue-600'}`}>1.</span>
                <span>Same Wi-Fi — or Tailscale (100.x) when off-site</span>
              </li>
              <li className="flex gap-2">
                <span className={`font-semibold shrink-0 ${darkMode ? 'text-[#82AAFF]' : 'text-blue-600'}`}>2.</span>
                <span>Scan the QR code or enter the URL</span>
              </li>
              <li className="flex gap-2">
                <span className={`font-semibold shrink-0 ${darkMode ? 'text-[#82AAFF]' : 'text-blue-600'}`}>3.</span>
                <span>Enter the join code when prompted</span>
              </li>
            </ol>

            {/* Main URL */}
            <div className={`
              px-3 py-2 rounded-md text-sm font-mono break-all
              ${darkMode ? 'bg-[#282946] text-[#D8DEE0]' : 'bg-gray-100 text-gray-800'}
            `}>
              {connectionURL}
            </div>

            {/* Network selector (LAN + Tailscale) */}
            {(allIPs.tailnet.length > 0 || allIPs.all.length > 1) && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {(allIPs.all.length > 0 ? allIPs.all : [{ address: localIP }]).map((entry) => {
                  const addr = typeof entry === 'string' ? entry : entry.address;
                  const isTailscale = typeof entry === 'object' ? entry.tailscale : String(addr).startsWith('100.');
                  const active = addr === localIP;
                  return (
                    <button
                      key={addr}
                      onClick={() => setLocalIP(addr)}
                      className={`px-2.5 py-1 rounded-full text-xs font-mono border ${active
                        ? (darkMode ? 'bg-[#7DDBD3] text-[#111231] border-[#7DDBD3]' : 'bg-blue-600 text-white border-blue-600')
                        : (darkMode ? 'border-[#282946] text-[#D8DEE0]' : 'border-gray-300 text-gray-700')}`}
                      title={isTailscale ? 'Tailscale tailnet — use off-site' : 'Local Wi-Fi'}
                    >
                      {isTailscale ? 'Tailscale ' : ''}{addr}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Join Code */}
            {joinCode && (
              <div
                className={`
                  px-3 py-2 rounded-md text-sm font-mono flex items-center justify-between
                  ${darkMode ? 'bg-[#282946] text-[#E8B45C]' : 'bg-[#E8B45C]/10 text-[#8B6914]'}
                `}
              >
                <span>Join Code: {joinCode}</span>
                <Button
                  onClick={() => copyToClipboard(joinCode, 'Join code')}
                  variant="ghost"
                  size="sm"
                  className={`ml-2 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[#7DDBD3] ${darkMode
                    ? 'text-[#D8DEE0] hover:bg-[#55464B]'
                    : 'text-gray-700 hover:bg-gray-200'
                    }`}
                >
                  Copy
                </Button>
              </div>
            )}

            {/* Lite Mode URL */}
            <div className="space-y-1.5">
              <div className={`flex items-center justify-center gap-1.5 text-xs ${darkMode ? 'text-[#55464B]' : 'text-gray-500'}`}>
                <Link className="w-3 h-3" />
                <span>For older devices</span>
              </div>
              <div className={`
                px-3 py-2 rounded-md text-sm font-mono break-all flex items-center justify-between
              ${darkMode ? 'bg-[#282946] text-[#D8DEE0]' : 'bg-gray-100 text-gray-800'}
              `}>
                <span className="truncate">{liteURL}</span>
                <Button
                  onClick={() => copyToClipboard(liteURL, 'Lite URL')}
                  variant="ghost"
                  size="sm"
                  className={`ml-2 shrink-0 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[#7DDBD3] ${darkMode
                    ? 'text-[#D8DEE0] hover:bg-[#55464B]'
                    : 'text-gray-700 hover:bg-gray-200'
                    }`}
                >
                  Copy
                </Button>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 pt-1">
            <Button
              onClick={copyAllConnectionInfo}
              variant="default"
              className="flex-1 gap-1.5 bg-[#7DDBD3] hover:bg-[#6BC9C1] text-[#111231]"
            >
              <Copy className="w-4 h-4" />
              Copy All
            </Button>
            <Button
              onClick={() => copyToClipboard(connectionURL, 'URL')}
              variant="outline"
              className="flex-1 gap-1.5 dark:text-white dark:border-[#282946] dark:hover:bg-[#282946]"
            >
              <Wifi className="w-4 h-4" />
              Copy URL
            </Button>
          </div>

        </div>
      </div>
    </div>
  );
};

export default QRCodeDialog;
