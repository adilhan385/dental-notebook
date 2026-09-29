import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  UserPlus,
  CalendarPlus,
  Calendar,
  Phone,
  Cake,
  ArrowRight,
  Wallet,
} from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
  onOpenPatient: (patientId: string) => void;
  onNewPatient: (initialName?: string) => void;
  onNewAppointment: () => void;
  onOpenCalendar: () => void;
  onOpenFinances: () => void;
}

export function HomeView({
  t,
  onOpenPatient,
  onNewPatient,
  onNewAppointment,
  onOpenCalendar,
  onOpenFinances,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const [todayAppointments, setTodayAppointments] = useState<any[]>([]);
  const [financePeriod, setFinancePeriod] = useState<'today' | 'week' | 'month'>('month');
  const [financeSummary, setFinanceSummary] = useState({
    visitCount: 0,
    totalServicesAmount: 0,
    totalPaid: 0,
    unpaidAmount: 0,
  });

  // Dynamic instant patient search while typing (does NOT auto-select)
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch<{ results: any[] }>(
          `/api/patients/search?q=${encodeURIComponent(trimmed)}&limit=10`
        );
        setSearchResults(res.results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 140);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadDashboardData = useCallback(async () => {
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);

    let fromIso = todayIso;
    if (financePeriod === 'week') {
      const d = new Date(today);
      d.setDate(d.getDate() - 6);
      fromIso = d.toISOString().slice(0, 10);
    } else if (financePeriod === 'month') {
      fromIso = `${todayIso.slice(0, 7)}-01`;
    }

    try {
      const [apptsRes, finRes] = await Promise.all([
        apiFetch<{ appointments: any[] }>(
          `/api/appointments?from=${todayIso}&to=${todayIso}`
        ),
        apiFetch<{ summary: any }>(
          `/api/finances/summary?from=${fromIso}&to=${todayIso}`
        ),
      ]);
      setTodayAppointments(apptsRes.appointments || []);
      if (finRes.summary) setFinanceSummary(finRes.summary);
    } catch {
      // handled
    }
  }, [financePeriod]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  return (
    <div className="page-stack">
      {/* Hero Search & Quick Actions Card */}
      <div className="card hero-search-card">
        <div className="row-between hero-header-row" style={{ marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{t.home.greeting}</h1>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {t.appSubtitle}
            </div>
          </div>

          <div className="hero-actions">
            <button
              className="btn btn-primary"
              onClick={() => onNewPatient(searchQuery.trim())}
            >
              <UserPlus size={16} />
              <span>{t.home.newPatientBtn.replace(/^\+\s*/, '')}</span>
            </button>
            <button
              className="btn btn-gold"
              onClick={onNewAppointment}
            >
              <CalendarPlus size={16} />
              <span>{t.home.newAppointmentBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        </div>

        {/* Prominent Patient Search Bar */}
        <div className="search-input-wrapper">
          <Search size={18} className="search-input-icon" />
          <input
            type="search"
            className="input input-hero-search input-with-icon"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.home.searchPlaceholder}
          />

          {searchQuery.trim().length > 0 && (
            <div className="search-suggestions-panel">
              {searching ? (
                <div className="search-suggestion-empty">...</div>
              ) : searchResults.length > 0 ? (
                searchResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="search-suggestion-row"
                    onClick={() => onOpenPatient(p.id)}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {p.full_name}
                      </div>
                      <div
                        className="muted"
                        style={{
                          fontSize: 12,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          marginTop: 2,
                        }}
                      >
                        {p.date_of_birth && (
                          <span className="icon-inline">
                            <Cake size={13} />
                            {formatDisplayDate(p.date_of_birth)}
                          </span>
                        )}
                        {p.iin_masked && <span>ИИН: {p.iin_masked}</span>}
                        {p.phone && (
                          <span className="icon-inline">
                            <Phone size={13} />
                            {p.phone}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="btn btn-secondary btn-sm">
                      <span>{t.home.openPatient}</span>
                      <ArrowRight size={14} />
                    </span>
                  </button>
                ))
              ) : (
                <div className="search-suggestion-empty">
                  <div style={{ marginBottom: 10 }}>{t.home.noSearchMatch}</div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => onNewPatient(searchQuery.trim())}
                  >
                    <UserPlus size={14} />
                    <span>
                      {t.home.createNewPatientAction.replace(/^\+\s*/, '')} «{searchQuery.trim()}»
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Two-Column Dashboard Layout: Today's Appointments + Compact Financial Summary */}
      <div className="dashboard-grid-2">
        {/* Today's Appointments */}
        <div className="card">
          <div className="row-between" style={{ marginBottom: 14 }}>
            <h2 className="section-title icon-inline" style={{ margin: 0 }}>
              <Calendar size={18} style={{ color: '#D4AF37' }} />
              <span>{t.home.todayAppointments}</span>
            </h2>
            <button className="btn btn-ghost btn-sm" onClick={onOpenCalendar}>
              <span>{t.nav.calendar}</span>
              <ArrowRight size={14} />
            </button>
          </div>

          {todayAppointments.length === 0 ? (
            <div className="empty-state">
              <p>{t.home.noAppointmentsToday}</p>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onNewAppointment}
              >
                <CalendarPlus size={15} />
                <span>{t.home.newAppointmentBtn.replace(/^\+\s*/, '')}</span>
              </button>
            </div>
          ) : (
            <div className="appointment-list">
              {todayAppointments.map((appt) => (
                <div
                  key={appt.id}
                  className="appointment-card-row"
                  onClick={() => onOpenPatient(appt.patient_id)}
                >
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <div className="time-pill">{appt.appointment_time}</div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {appt.patient_name}
                      </div>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {appt.service_name_snapshot || 'Приём'}
                        {appt.comment ? ` • ${appt.comment}` : ''}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {appt.estimated_price !== null &&
                      appt.estimated_price !== undefined && (
                        <div style={{ fontWeight: 700, color: '#0F172A' }}>
                          {formatKzt(appt.estimated_price)}
                        </div>
                      )}
                    <span className="btn-link icon-inline" style={{ fontSize: 12, justifyContent: 'flex-end' }}>
                      <span>{t.home.openPatient}</span>
                      <ArrowRight size={13} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Compact Financial Summary */}
        <div className="card">
          <div className="row-between" style={{ marginBottom: 14 }}>
            <h2 className="section-title icon-inline" style={{ margin: 0 }}>
              <Wallet size={18} style={{ color: '#D4AF37' }} />
              <span>{t.home.quickFinanceTitle}</span>
            </h2>
            <div className="segmented-tabs">
              <button
                type="button"
                className={`seg-tab ${financePeriod === 'today' ? 'active' : ''}`}
                onClick={() => setFinancePeriod('today')}
              >
                {t.finances.periodToday}
              </button>
              <button
                type="button"
                className={`seg-tab ${financePeriod === 'week' ? 'active' : ''}`}
                onClick={() => setFinancePeriod('week')}
              >
                {t.finances.periodWeek}
              </button>
              <button
                type="button"
                className={`seg-tab ${financePeriod === 'month' ? 'active' : ''}`}
                onClick={() => setFinancePeriod('month')}
              >
                {t.finances.periodMonth}
              </button>
            </div>
          </div>

          <div className="metrics-grid-2">
            <div className="metric-card">
              <div className="metric-label">{t.finances.totalServices}</div>
              <div className="metric-value">
                {formatKzt(financeSummary.totalServicesAmount)}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-label">{t.finances.totalPaid}</div>
              <div className="metric-value metric-paid">
                {formatKzt(financeSummary.totalPaid)}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-label">{t.finances.totalUnpaid}</div>
              <div
                className={`metric-value ${
                  financeSummary.unpaidAmount > 0 ? 'metric-unpaid' : ''
                }`}
              >
                {formatKzt(financeSummary.unpaidAmount)}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-label">{t.finances.visitsCount}</div>
              <div className="metric-value">{financeSummary.visitCount}</div>
            </div>
          </div>

          <div style={{ marginTop: 14, textAlign: 'right' }}>
            <button className="btn btn-ghost btn-sm" onClick={onOpenFinances}>
              <span>{t.nav.finances}</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
