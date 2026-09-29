import React, { useState, useEffect, useCallback } from 'react';
import {
  LayoutGrid,
  Users,
  Calendar,
  Package,
  Wallet,
  Archive,
  Settings,
  LogOut,
  ArrowLeft,
} from 'lucide-react';
import {
  translations,
  type Language,
} from './i18n/translations';
import {
  apiFetch,
  setCsrfToken,
  performLogout,
  syncOfflineMutations,
  ApiError,
} from './services/api';
import { HomeView } from './components/HomeView';
import { PatientsListView } from './components/PatientsListView';
import { PatientCardView } from './components/PatientCardView';
import { CalendarView } from './components/CalendarView';
import { FinancesView } from './components/FinancesView';
import { InventoryView } from './components/InventoryView';
import { ArchiveView } from './components/ArchiveView';
import { SettingsView } from './components/SettingsView';
import { PatientModal } from './components/PatientModal';

type NavTab =
  | 'home'
  | 'patients'
  | 'calendar'
  | 'inventory'
  | 'finances'
  | 'archive'
  | 'settings';

export function App() {
  const [lang, setLang] = useState<Language>('ru');
  const t = translations[lang];

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [account, setAccount] = useState<any | null>(null);
  const [clinic, setClinic] = useState<any | null>(null);
  const [servicesCatalog, setServicesCatalog] = useState<any[]>([]);

  // Navigation state
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [creatingPatientInitialName, setCreatingPatientInitialName] = useState<
    string | null
  >(null);
  const [openCalendarCreate, setOpenCalendarCreate] = useState(false);
  const [syncNotice, setSyncNotice] = useState('');

  // Login & Recovery Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requires2fa, setRequires2fa] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoverySentMsg, setRecoverySentMsg] = useState('');

  const loadServicesCatalog = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/services');
      setServicesCatalog(res.services || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    async function checkSession() {
      try {
        const res = await apiFetch('/api/auth/me');
        if (res.authenticated) {
          setCsrfToken(res.csrfToken);
          setAuthenticated(true);
          setAccount(res.account);
          setClinic(res.clinic);
          if (res.clinic?.default_language) {
            setLang(res.clinic.default_language as Language);
          }
          await loadServicesCatalog();
        }
      } catch {
        setAuthenticated(false);
      } finally {
        setCheckingAuth(false);
      }
    }
    checkSession();
  }, [loadServicesCatalog]);

  // Automatic offline queue synchronization when connection returns
  useEffect(() => {
    if (!authenticated) return;
    const handleOnline = async () => {
      const count = await syncOfflineMutations();
      if (count > 0) {
        setSyncNotice(t.sync.saved);
        setTimeout(() => setSyncNotice(''), 3500);
      }
    };
    window.addEventListener('online', handleOnline);
    const interval = setInterval(handleOnline, 15000);
    return () => {
      window.removeEventListener('online', handleOnline);
      clearInterval(interval);
    };
  }, [authenticated, t.sync.saved]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: {
          email: email.trim(),
          password,
          ...(requires2fa && totpCode ? { totpCode: totpCode.trim() } : {}),
        },
      });

      if (res.requiresTwoFactor) {
        setRequires2fa(true);
        return;
      }

      setCsrfToken(res.csrfToken);
      setAuthenticated(true);
      setAccount(res.account);
      setClinic(res.clinic);
      setPassword('');
      setTotpCode('');
      setRequires2fa(false);
      await loadServicesCatalog();
    } catch (err) {
      setAuthError(
        err instanceof ApiError ? err.message : 'Ошибка входа в систему'
      );
    }
  }

  async function handleRequestReset(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    const res = await apiFetch('/api/auth/request-reset', {
      method: 'POST',
      body: { email: email.trim() },
    });
    setRecoverySentMsg(res.message);
  }

  async function handleSignOut() {
    await performLogout();
    setAuthenticated(false);
    setAccount(null);
    setClinic(null);
    setSelectedPatientId(null);
  }

  if (checkingAuth) {
    return (
      <div className="login-wrapper">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <h3>{t.appName}</h3>
          <div className="muted">Загрузка защищённой сессии...</div>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="login-wrapper">
        <div className="login-card">
          <div className="row-between" style={{ marginBottom: 18 }}>
            <div className="brand-title" style={{ color: '#0F172A' }}>
              <span className="brand-gold-dot" />
              {t.appName}
            </div>
            <div className="segmented-tabs">
              {(['ru', 'kz', 'en'] as Language[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`seg-tab ${lang === l ? 'active' : ''}`}
                  onClick={() => setLang(l)}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {!showRecovery ? (
            <form onSubmit={handleLogin} className="form-stack">
              <div>
                <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>
                  {t.auth.loginTitle}
                </h2>
                <div className="muted" style={{ fontSize: 13 }}>
                  {t.auth.loginSubtitle}
                </div>
              </div>

              {authError && <div className="alert alert-error">{authError}</div>}

              <div className="form-group">
                <label>{t.auth.emailLabel}</label>
                <input
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label>{t.auth.passwordLabel}</label>
                <input
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
              </div>

              {requires2fa && (
                <div className="form-group">
                  <label>{t.auth.totpLabel}</label>
                  <input
                    type="text"
                    maxLength={6}
                    className="input"
                    value={totpCode}
                    onChange={(e) =>
                      setTotpCode(e.target.value.replace(/\D/g, ''))
                    }
                    required
                  />
                </div>
              )}

              <button type="submit" className="btn btn-primary btn-lg">
                {t.auth.loginButton}
              </button>

              <div className="row-between" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setShowRecovery(true)}
                >
                  {t.auth.forgotPassword}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRequestReset} className="form-stack">
              <h3>{t.auth.resetTitle}</h3>
              {recoverySentMsg && (
                <div className="alert alert-success">{recoverySentMsg}</div>
              )}
              <div className="form-group">
                <label>{t.auth.emailLabel}</label>
                <input
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">
                {t.auth.sendResetButton}
              </button>
              <button
                type="button"
                className="btn-link icon-inline"
                onClick={() => {
                  setShowRecovery(false);
                  setRecoverySentMsg('');
                }}
              >
                <ArrowLeft size={14} />
                <span>{t.auth.backToLogin}</span>
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-title">
            <span className="brand-gold-dot" />
            <span>{t.appName}</span>
          </div>
          <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 4 }}>
            {clinic?.name}
          </div>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-btn ${
              activeTab === 'home' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('home');
            }}
          >
            <LayoutGrid size={18} strokeWidth={2} />
            <span>{t.nav.home}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'patients' || selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('patients');
            }}
          >
            <Users size={18} strokeWidth={2} />
            <span>{t.nav.patients}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'calendar' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('calendar');
            }}
          >
            <Calendar size={18} strokeWidth={2} />
            <span>{t.nav.calendar}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'inventory' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('inventory');
            }}
          >
            <Package size={18} strokeWidth={2} />
            <span>{t.nav.inventory}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'finances' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('finances');
            }}
          >
            <Wallet size={18} strokeWidth={2} />
            <span>{t.nav.finances}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'archive' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('archive');
            }}
          >
            <Archive size={18} strokeWidth={2} />
            <span>{t.nav.archive}</span>
          </button>

          <button
            className={`nav-btn ${
              activeTab === 'settings' && !selectedPatientId ? 'active' : ''
            }`}
            onClick={() => {
              setSelectedPatientId(null);
              setActiveTab('settings');
            }}
          >
            <Settings size={18} strokeWidth={2} />
            <span>{t.nav.settings}</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          {/* Language Switcher RU / KZ / EN */}
          <div className="lang-switcher" aria-label="Language Switcher">
            {(['ru', 'kz', 'en'] as Language[]).map((l) => (
              <button
                key={l}
                type="button"
                className={`lang-btn ${lang === l ? 'active' : ''}`}
                onClick={() => setLang(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          <button className="nav-btn" onClick={handleSignOut}>
            <LogOut size={18} strokeWidth={2} />
            <span>{t.nav.logout}</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-area">
        <header className="topbar">
          <div className="sync-pill">
            <span className="sync-dot" />
            <span>{syncNotice || t.sync.saved}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {t.sync.sharedDeviceNote}
          </div>
        </header>

        <main className="content-container">
          {selectedPatientId ? (
            <PatientCardView
              t={t}
              lang={lang}
              patientId={selectedPatientId}
              clinic={clinic}
              servicesCatalog={servicesCatalog}
              onBack={() => setSelectedPatientId(null)}
              onArchived={() => {
                setSelectedPatientId(null);
                setActiveTab('archive');
              }}
              onSyncNotice={(msg) => setSyncNotice(msg)}
            />
          ) : activeTab === 'home' ? (
            <HomeView
              t={t}
              onOpenPatient={(id) => setSelectedPatientId(id)}
              onNewPatient={(initName) =>
                setCreatingPatientInitialName(initName ?? '')
              }
              onNewAppointment={() => {
                setOpenCalendarCreate(true);
                setActiveTab('calendar');
              }}
              onOpenCalendar={() => setActiveTab('calendar')}
              onOpenFinances={() => setActiveTab('finances')}
            />
          ) : activeTab === 'patients' ? (
            <PatientsListView
              t={t}
              onOpenPatient={(id) => setSelectedPatientId(id)}
              onNewPatient={(initName) =>
                setCreatingPatientInitialName(initName ?? '')
              }
            />
          ) : activeTab === 'calendar' ? (
            <CalendarView
              t={t}
              lang={lang}
              servicesCatalog={servicesCatalog}
              initialOpenCreate={openCalendarCreate}
              onClearInitialCreate={() => setOpenCalendarCreate(false)}
              onOpenPatient={(id) => setSelectedPatientId(id)}
            />
          ) : activeTab === 'finances' ? (
            <FinancesView
              t={t}
              clinic={clinic}
              onOpenPatient={(id) => setSelectedPatientId(id)}
            />
          ) : activeTab === 'inventory' ? (
            <InventoryView t={t} />
          ) : activeTab === 'archive' ? (
            <ArchiveView t={t} />
          ) : (
            <SettingsView
              t={t}
              clinic={clinic}
              account={account}
              servicesCatalog={servicesCatalog}
              onClinicUpdated={(c) => setClinic(c)}
              onServicesUpdated={loadServicesCatalog}
            />
          )}
        </main>
      </div>

      {/* Global Create Patient Modal */}
      {creatingPatientInitialName !== null && (
        <PatientModal
          t={t}
          initialName={creatingPatientInitialName}
          onClose={() => setCreatingPatientInitialName(null)}
          onSaved={(newPatient) => {
            setCreatingPatientInitialName(null);
            setSelectedPatientId(newPatient.id);
          }}
          onSyncNotice={(msg) => setSyncNotice(msg)}
        />
      )}
    </div>
  );
}
