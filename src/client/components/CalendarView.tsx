import React, { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarPlus,
  ArrowRight,
  X,
} from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type Language,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
  lang: Language;
  servicesCatalog: any[];
  initialOpenCreate?: boolean;
  onClearInitialCreate?: () => void;
  onOpenPatient: (patientId: string) => void;
}

export function CalendarView({
  t,
  lang,
  servicesCatalog,
  initialOpenCreate = false,
  onClearInitialCreate,
  onOpenPatient,
}: Props) {
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'month'>('week');
  const [anchorDate, setAnchorDate] = useState(
    () => new Date().toISOString().slice(0, 10)
  );
  const [appointments, setAppointments] = useState<any[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(initialOpenCreate);
  const [editingAppt, setEditingAppt] = useState<any | null>(null);

  // Appointment Form State
  const [patientSearch, setPatientSearch] = useState('');
  const [patientOptions, setPatientOptions] = useState<any[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<any | null>(null);
  const [apptDate, setApptDate] = useState(anchorDate);
  const [apptTime, setApptTime] = useState('15:00');
  const [serviceText, setServiceText] = useState('');
  const [estimatedPrice, setEstimatedPrice] = useState<string>('');
  const [comment, setComment] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (initialOpenCreate) {
      setShowCreateModal(true);
      onClearInitialCreate?.();
    }
  }, [initialOpenCreate, onClearInitialCreate]);

  function getDateRange(): { from: string; to: string; days: string[] } {
    const base = new Date(`${anchorDate}T00:00:00Z`);
    if (viewMode === 'day') {
      return { from: anchorDate, to: anchorDate, days: [anchorDate] };
    }
    if (viewMode === 'week') {
      const dayOfWeek = base.getUTCDay(); // 0=Sun..6=Sat
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(base);
      monday.setUTCDate(base.getUTCDate() + diffToMonday);
      const days: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + i);
        days.push(d.toISOString().slice(0, 10));
      }
      return { from: days[0], to: days[6], days };
    }
    // Month view
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const firstDay = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const days: string[] = [];
    for (let d = 1; d <= lastDay.getUTCDate(); d++) {
      days.push(new Date(Date.UTC(year, month, d)).toISOString().slice(0, 10));
    }
    return {
      from: firstDay.toISOString().slice(0, 10),
      to: lastDay.toISOString().slice(0, 10),
      days,
    };
  }

  const { from, to, days } = getDateRange();

  const loadAppointments = useCallback(async () => {
    try {
      const res = await apiFetch<{ appointments: any[] }>(
        `/api/appointments?from=${from}&to=${to}`
      );
      setAppointments(res.appointments || []);
    } catch {
      // handled
    }
  }, [from, to]);

  useEffect(() => {
    loadAppointments();
  }, [loadAppointments]);

  useEffect(() => {
    if (!patientSearch.trim() || selectedPatient) {
      setPatientOptions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await apiFetch<{ results: any[] }>(
          `/api/patients/search?q=${encodeURIComponent(patientSearch.trim())}&limit=8`
        );
        setPatientOptions(r.results || []);
      } catch {
        setPatientOptions([]);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [patientSearch, selectedPatient]);

  function shiftDate(deltaDays: number) {
    const dt = new Date(`${anchorDate}T00:00:00Z`);
    if (viewMode === 'month') {
      dt.setUTCMonth(dt.getUTCMonth() + (deltaDays > 0 ? 1 : -1));
    } else if (viewMode === 'week') {
      dt.setUTCDate(dt.getUTCDate() + deltaDays * 7);
    } else {
      dt.setUTCDate(dt.getUTCDate() + deltaDays);
    }
    setAnchorDate(dt.toISOString().slice(0, 10));
  }

  function openNewModal(defaultDate = anchorDate) {
    setEditingAppt(null);
    setSelectedPatient(null);
    setPatientSearch('');
    setApptDate(defaultDate);
    setApptTime('15:30');
    setServiceText('');
    setEstimatedPrice('');
    setComment('');
    setFormError('');
    setShowCreateModal(true);
  }

  function openEditModal(appt: any) {
    setEditingAppt(appt);
    setSelectedPatient({ id: appt.patient_id, full_name: appt.patient_name });
    setPatientSearch(appt.patient_name);
    setApptDate(appt.appointment_date);
    setApptTime(appt.appointment_time);
    setServiceText(appt.service_name_snapshot || '');
    setEstimatedPrice(
      appt.estimated_price !== null && appt.estimated_price !== undefined
        ? String(appt.estimated_price)
        : ''
    );
    setComment(appt.comment || '');
    setFormError('');
    setShowCreateModal(true);
  }

  async function handleSaveAppointment(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!editingAppt && !selectedPatient) {
      setFormError('Выберите пациента из списка поиска.');
      return;
    }

    try {
      if (editingAppt) {
        await apiFetch(`/api/appointments/${editingAppt.id}`, {
          method: 'PATCH',
          body: {
            appointment_date: apptDate,
            appointment_time: apptTime,
            service_name_snapshot: serviceText.trim() || null,
            estimated_price: estimatedPrice ? Number(estimatedPrice) : null,
            comment: comment.trim() || null,
          },
        });
      } else {
        await apiFetch('/api/appointments', {
          method: 'POST',
          body: {
            patient_id: selectedPatient.id,
            appointment_date: apptDate,
            appointment_time: apptTime,
            service_name_snapshot: serviceText.trim() || null,
            estimated_price: estimatedPrice ? Number(estimatedPrice) : null,
            comment: comment.trim() || null,
          },
        });
      }
      setShowCreateModal(false);
      loadAppointments();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ошибка сохранения записи');
    }
  }

  async function handleDeleteAppointment(id: string) {
    await apiFetch(`/api/appointments/${id}`, { method: 'DELETE' });
    setShowCreateModal(false);
    loadAppointments();
  }

  return (
    <div className="page-stack">
      {/* Calendar Header & View Switcher */}
      <div className="card">
        <div className="row-between calendar-header-row">
          <div className="calendar-nav-group">
            <h1 style={{ margin: 0, fontSize: 22 }}>{t.calendar.title}</h1>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => shiftDate(-1)}>
                <ChevronLeft size={16} />
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setAnchorDate(new Date().toISOString().slice(0, 10))}
              >
                {t.calendar.today}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => shiftDate(1)}>
                <ChevronRight size={16} />
              </button>
            </div>
            <span className="calendar-date-label">
              {formatDisplayDate(from)}
              {from !== to ? ` — ${formatDisplayDate(to)}` : ''}
            </span>
          </div>

          <div className="calendar-controls-group">
            <div className="segmented-tabs">
              <button
                type="button"
                className={`seg-tab ${viewMode === 'day' ? 'active' : ''}`}
                onClick={() => setViewMode('day')}
              >
                {t.calendar.day}
              </button>
              <button
                type="button"
                className={`seg-tab ${viewMode === 'week' ? 'active' : ''}`}
                onClick={() => setViewMode('week')}
              >
                {t.calendar.week}
              </button>
              <button
                type="button"
                className={`seg-tab ${viewMode === 'month' ? 'active' : ''}`}
                onClick={() => setViewMode('month')}
              >
                {t.calendar.month}
              </button>
            </div>

            <button className="btn btn-primary" onClick={() => openNewModal()}>
              <CalendarPlus size={16} />
              <span>{t.calendar.newAppointment.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Calendar Grid */}
      <div
        className={
          viewMode === 'day'
            ? 'calendar-day-grid'
            : viewMode === 'week'
            ? 'calendar-week-grid'
            : 'calendar-month-grid'
        }
      >
        {days.map((dayIso) => {
          const dayAppts = appointments.filter((a) => a.appointment_date === dayIso);
          const isToday = dayIso === new Date().toISOString().slice(0, 10);

          return (
            <div
              key={dayIso}
              className={`calendar-day-column ${isToday ? 'calendar-day-today' : ''}`}
            >
              <div className="calendar-day-header">
                <span>{formatDisplayDate(dayIso)}</span>
                <button
                  type="button"
                  className="btn-icon"
                  title={t.calendar.newAppointment}
                  onClick={() => openNewModal(dayIso)}
                >
                  <Plus size={16} />
                </button>
              </div>

              <div className="calendar-day-body">
                {dayAppts.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
                    —
                  </div>
                ) : (
                  dayAppts.map((appt) => (
                    <div
                      key={appt.id}
                      className="calendar-appt-card"
                      onClick={() => openEditModal(appt)}
                    >
                      <div className="row-between">
                        <span className="time-badge">{appt.appointment_time}</span>
                        {appt.estimated_price !== null &&
                          appt.estimated_price !== undefined && (
                            <span style={{ fontWeight: 700, fontSize: 12 }}>
                              {formatKzt(appt.estimated_price)}
                            </span>
                          )}
                      </div>
                      <div style={{ fontWeight: 700, marginTop: 4 }}>
                        {appt.patient_name}
                      </div>
                      {appt.service_name_snapshot && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {appt.service_name_snapshot}
                        </div>
                      )}
                      <div style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          className="btn-link icon-inline"
                          style={{ fontSize: 11 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenPatient(appt.patient_id);
                          }}
                        >
                          <span>{t.home.openPatient}</span>
                          <ArrowRight size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Reschedule Appointment Modal */}
      {showCreateModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowCreateModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingAppt
                  ? t.calendar.editAppointment
                  : t.calendar.newAppointment.replace(/^\+\s*/, '')}
              </h3>
              <button
                className="btn-icon"
                onClick={() => setShowCreateModal(false)}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveAppointment} className="form-stack">
              {formError && <div className="alert alert-error">{formError}</div>}

              <div className="form-group" style={{ position: 'relative' }}>
                <label>{t.calendar.patientLabel} *</label>
                <input
                  type="text"
                  className="input"
                  value={patientSearch}
                  disabled={Boolean(editingAppt)}
                  onChange={(e) => {
                    setPatientSearch(e.target.value);
                    setSelectedPatient(null);
                  }}
                  placeholder={t.home.searchPlaceholder}
                  required
                />
                {patientOptions.length > 0 && !selectedPatient && (
                  <div className="autocomplete-dropdown">
                    {patientOptions.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        className="autocomplete-item"
                        onClick={() => {
                          setSelectedPatient(p);
                          setPatientSearch(p.full_name);
                          setPatientOptions([]);
                        }}
                      >
                        <span>{p.full_name}</span>
                        <span className="muted">{p.phone || ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="form-row-2">
                <div className="form-group">
                  <label>{t.patients.date} *</label>
                  <input
                    type="date"
                    className="input"
                    value={apptDate}
                    onChange={(e) => setApptDate(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>{t.patients.time} *</label>
                  <input
                    type="time"
                    className="input"
                    value={apptTime}
                    onChange={(e) => setApptTime(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t.patients.service}</label>
                <input
                  type="text"
                  className="input"
                  list="calendar-service-suggestions"
                  value={serviceText}
                  onChange={(e) => {
                    const val = e.target.value;
                    setServiceText(val);
                    const matched = servicesCatalog.find(
                      (s) =>
                        s.name_ru === val ||
                        s.name_kz === val ||
                        s.name_en === val
                    );
                    if (matched && matched.reference_price !== null) {
                      setEstimatedPrice(String(matched.reference_price));
                    }
                  }}
                  placeholder={t.visit.servicePlaceholder}
                />
                <datalist id="calendar-service-suggestions">
                  {servicesCatalog.map((s) => (
                    <option
                      key={s.id}
                      value={
                        lang === 'kz'
                          ? s.name_kz
                          : lang === 'en'
                          ? s.name_en
                          : s.name_ru
                      }
                    />
                  ))}
                </datalist>
              </div>

              <div className="form-row-2">
                <div className="form-group">
                  <label>{t.patients.price} (₸)</label>
                  <input
                    type="number"
                    min={0}
                    step={500}
                    className="input"
                    value={estimatedPrice}
                    onChange={(e) => setEstimatedPrice(e.target.value)}
                    placeholder="30000"
                  />
                </div>
                <div className="form-group">
                  <label>{t.calendar.commentLabel}</label>
                  <input
                    type="text"
                    className="input"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-actions">
                {editingAppt && (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger-outline"
                      onClick={() => handleDeleteAppointment(editingAppt.id)}
                    >
                      {t.calendar.deleteAppointmentBtn}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowCreateModal(false);
                        onOpenPatient(editingAppt.patient_id);
                      }}
                    >
                      {t.home.openPatient}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  {t.patients.cancelBtn}
                </button>
                <button type="submit" className="btn btn-primary">
                  {t.patients.saveBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
