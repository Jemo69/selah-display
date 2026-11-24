import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import ShortcutsHelpBridge from './components/ShortcutsHelpBridge';
import JoinCodePromptBridge from './components/JoinCodePromptBridge';
import SupportDevelopmentBridge from './components/SupportDevelopmentBridge';
import { useDarkModeState, useIsDesktopApp } from './hooks/useStoreSelectors';
import useLyricsStore from './context/LyricsStore';
import { ToastProvider } from '@/components/toast/ToastProvider';
import { ModalProvider } from '@/components/modal/ModalProvider';
import useToast from '@/hooks/useToast';
import useModal from '@/hooks/useModal';
import ElectronModalBridge from './components/ElectronModalBridge';
import QRCodeDialogBridge from './components/QRCodeDialogBridge';
import { ControlSocketProvider } from './context/ControlSocketProvider';
import { convertMarkdownToHTML, trimReleaseNotes, formatReleaseNotes } from './utils/markdownParser';
import DesktopShell from './components/WindowChrome/DesktopShell';
import FileNavigatorModal from './components/FileNavigatorModal';
import FileNavigatorSaveModal from './components/FileNavigatorSaveModal';
import { canUseFileNavigator } from './utils/fileNavigatorEvents';
import FHintOverlay from './components/FHintOverlay';

const log = (level, ...args) => {
  console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}] [AppRoot]`, ...args);
};

const ControlPanel = lazy(() => import('./pages/ControlPanel'));
const Output1 = lazy(() => import('./pages/Output1'));
const Output2 = lazy(() => import('./pages/Output2'));
const StreamOutput = lazy(() => import('./pages/StreamOutput'));
const Stage = lazy(() => import('./pages/Stage'));
const Time = lazy(() => import('./pages/Time'));
const NewSongCanvas = lazy(() => import('./components/NewSongCanvas'));
const DynamicOutputRoute = lazy(() => import('./pages/DynamicOutputRoute'));
const LiteController = lazy(() => import('./pages/LiteController'));
const ObsDock = lazy(() => import('./pages/ObsDock'));
const Preview = lazy(() => import('./pages/Preview'));

const Router = import.meta.env.MODE === 'development' ? BrowserRouter : HashRouter;

function ConditionalDesktopShell({ children }) {
  const isDesktopApp = useIsDesktopApp();

  if (isDesktopApp) {
    return <DesktopShell>{children}</DesktopShell>;
  }

  return <>{children}</>;
}

function RouteFallback() {
  return null;
}

export default function App() {
  const { darkMode } = useDarkModeState();

  useEffect(() => {
    log('info', 'App mounted');
  }, []);

  return (
    <ModalProvider isDark={!!darkMode}>
      <ToastProvider isDark={!!darkMode}>
        <AppErrorBoundary>
          <ElectronModalBridge />
          <JoinCodePromptBridge />
          <WelcomeSplashBridge />
          <UpdaterBridge />
          <QRCodeDialogBridge />
          <ShortcutsHelpBridge />
          <SupportDevelopmentBridge />
          <FileNavigatorBridge darkMode={!!darkMode} />
          <FHintOverlay />
          <Router>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={
                  <ConditionalDesktopShell>
                    <ControlSocketProvider>
                      <ControlPanel />
                    </ControlSocketProvider>
                  </ConditionalDesktopShell>
                } />
                <Route path="/output1" element={<Output1 />} />
                <Route path="/output2" element={<Output2 />} />
                <Route path="/stream" element={<StreamOutput />} />
                <Route path="/stage" element={<Stage />} />
                <Route path="/time" element={<Time />} />
                <Route path="/new-song" element={
                  <ConditionalDesktopShell>
                    <ControlSocketProvider>
                      <NewSongCanvas />
                    </ControlSocketProvider>
                  </ConditionalDesktopShell>
                } />
                <Route path="/lite" element={
                  <ControlSocketProvider>
                    <LiteController />
                  </ControlSocketProvider>
                } />
                <Route path="/obs-dock" element={<ObsDock />} />
                <Route path="/preview" element={<Preview />} />
                <Route path="/:outputName" element={<DynamicOutputRoute />} />
              </Routes>
            </Suspense>
          </Router>
        </AppErrorBoundary>
      </ToastProvider>
    </ModalProvider>
  );
}

function FileNavigatorBridge({ darkMode }) {
  if (!canUseFileNavigator()) return null;
  return (
    <>
      <FileNavigatorModal darkMode={darkMode} />
      <FileNavigatorSaveModal darkMode={darkMode} />
    </>
  );
}

function WelcomeSplashBridge() {
  const hasSeenWelcome = useLyricsStore((state) => state.hasSeenWelcome);
  const setHasSeenWelcome = useLyricsStore((state) => state.setHasSeenWelcome);
  const { showModal } = useModal();
  const { darkMode } = useDarkModeState();

  useEffect(() => {
    if (hasSeenWelcome || !window.electronAPI) return;

    const timer = setTimeout(() => {
      showModal({
        title: 'Welcome to Selah',
        component: 'WelcomeSplash',
        variant: 'info',
        size: 'lg',
        dismissible: true,
        actions: [
          {
            label: 'View Integration Guide',
            variant: 'default',
            onSelect: () => {
              showModal({
                title: 'Streaming Software Integration',
                headerDescription: 'Connect Selah to OBS, vMix, Wirecast and more',
                component: 'IntegrationInstructions',
                variant: 'info',
                size: 'lg',
                dismissLabel: 'Close'
              });
            }
          },
          {
            label: 'Get Started',
            variant: 'outline',
            onSelect: () => { }
          }
        ]
      });
      setHasSeenWelcome(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, [hasSeenWelcome, setHasSeenWelcome, showModal, darkMode]);

  return null;
}

function UpdaterBridge() {
  const { showToast } = useToast();
  const { showModal } = useModal();

  useEffect(() => {
    if (!window.electronAPI) return;

    const offAvail = window.electronAPI.onUpdateAvailable?.((info) => {
      const version = info?.version || '';
      const releaseName = info?.releaseName || '';
      const releaseNotes = info?.releaseNotes || '';
      const releaseDate = info?.releaseDate || '';
      let formattedNotes = formatReleaseNotes(releaseNotes);
      formattedNotes = trimReleaseNotes(formattedNotes);
      formattedNotes = convertMarkdownToHTML(formattedNotes);

      const descriptionParts = [];

      if (version) {
        descriptionParts.push(`Version ${version} is available.`);
      } else {
        descriptionParts.push('A new version is available.');
      }

      if (releaseName && releaseName !== version) {
        descriptionParts.push(releaseName);
      }

      if (releaseDate) {
        try {
          const date = new Date(releaseDate);
          const formattedDate = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          descriptionParts.push(`Released: ${formattedDate}`);
        } catch (e) {
        }
      }

      const description = descriptionParts.join('\n');

      showModal({
        title: 'Update Available',
        description: description,
        body: ({ isDark }) => (
          <div className="space-y-4">
            {formattedNotes && (
              <div className={`rounded-lg overflow-hidden border ${isDark
                ? 'bg-gray-800/50 border-gray-700'
                : 'bg-gray-50 border-gray-200'
                }`}>
                <div className={`px-4 py-2.5 border-b ${isDark
                  ? 'bg-gray-800 border-gray-700'
                  : 'bg-gray-100 border-gray-200'
                  }`}>
                  <h4 className={`text-sm font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'
                    }`}>Release Notes</h4>
                </div>
                <div className="px-4 py-3 max-h-64 overflow-y-auto">
                  <div
                    className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                    style={{
                      lineHeight: '1.6',
                      color: isDark ? '#d1d5db' : '#374151'
                    }}
                    dangerouslySetInnerHTML={{ __html: formattedNotes }}
                  />
                </div>
              </div>
            )}
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
              Would you like to download and install this update now?
            </p>
          </div>
        ),
        variant: 'info',
        dismissible: true,
        size: 'lg',
        actions: [
          {
            label: 'Later',
            variant: 'outline',
            value: 'later'
          },
          {
            label: 'Update Now',
            variant: 'default',
            value: 'update',
            onSelect: async () => {
              window.electronAPI.requestUpdateDownload?.();
            }
          },
        ],
      });
    });
    const offDownloaded = window.electronAPI.onUpdateDownloaded?.(() => {
      showToast({
        title: 'Update ready to install',
        message: 'Install and restart now?',
        variant: 'success',
        duration: 0,
        actions: [
          { label: 'Install and Restart', onClick: () => window.electronAPI.requestInstallAndRestart?.() },
          { label: 'Later', onClick: () => { } },
        ],
      });
    });
    const offErr = window.electronAPI.onUpdateError?.((msg) => {
      const detail = msg ? String(msg) : '';
      try { console.warn('Update check failed:', detail); } catch { }
      showToast({
        title: 'Unable to check for updates',
        message: 'We could not reach the update service. Please check your internet connection and try again later.',
        variant: 'warning',
        duration: 7000,
      });
    });
    return () => { offAvail?.(); offDownloaded?.(); offErr?.(); };
  }, [showToast, showModal]);
  return null;
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    log('error', 'Error boundary caught:', error, info);
  }
  handleRetry = () => {
    this.setState({ hasError: false, error: null, showDetails: false });
  };
  handleGoHome = () => {
    window.location.href = '/';
  };
  toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 24,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#111827',
          backgroundColor: '#f9fafb',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div style={{
            maxWidth: 480,
            width: '100%',
            backgroundColor: '#fff',
            borderRadius: 12,
            boxShadow: '0 4px 24px rgba(0,0,0,0.1)',
            padding: 32
          }}>
            <h2 style={{ margin: 0, marginBottom: 8, color: '#b91c1c', fontSize: 20 }}>
              Something went wrong
            </h2>
            <p style={{ margin: 0, marginBottom: 16, color: '#6b7280', fontSize: 14 }}>
              An unexpected error occurred. You can try again or return to the home page.
            </p>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <button
                onClick={this.handleRetry}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500
                }}
              >
                Try Again
              </button>
              <button
                onClick={this.handleGoHome}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#fff',
                  color: '#374151',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500
                }}
              >
                Go to Home
              </button>
            </div>
            <button
              onClick={this.toggleDetails}
              style={{
                padding: 0,
                background: 'none',
                border: 'none',
                color: '#6b7280',
                cursor: 'pointer',
                fontSize: 13,
                textDecoration: 'underline'
              }}
            >
              {this.state.showDetails ? 'Hide details' : 'Show details'}
            </button>
            {this.state.showDetails && (
              <pre style={{
                marginTop: 12,
                padding: 12,
                backgroundColor: '#f3f4f6',
                borderRadius: 8,
                fontSize: 12,
                color: '#374151',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 200
              }}>
                {String(this.state.error?.message || this.state.error || 'Unknown error')}
                {'\n\n'}
                {this.state.error?.stack || ''}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}