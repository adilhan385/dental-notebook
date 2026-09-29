import React, { useState, useEffect, useCallback } from 'react';
import { Search, UserPlus, AlertTriangle, ArrowRight } from 'lucide-react';
import { formatDisplayDate, type TranslationDict } from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
  onOpenPatient: (patientId: string) => void;
  onNewPatient: (initialName?: string) => void;
}

export function PatientsListView({ t, onOpenPatient, onNewPatient }: Props) {
  const [search, setSearch] = useState('');
  const [patients, setPatients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPatients = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/patients?q=${encodeURIComponent(search.trim())}&limit=50`
      );
      setPatients(res.patients || []);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(loadPatients, 140);
    return () => clearTimeout(timer);
  }, [loadPatients]);

  return (
    <div className="page-stack">
      <div className="card">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t.patients.title}</h1>
          <div style={{ display: 'flex', gap: 10, flex: 1, maxWidth: 560 }}>
            <div className="search-input-wrapper">
              <Search size={16} className="search-input-icon" />
              <input
                type="search"
                className="input input-with-icon"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.home.searchPlaceholder}
                autoFocus
              />
            </div>
            <button
              className="btn btn-primary"
              style={{ whiteSpace: 'nowrap' }}
              onClick={() => onNewPatient(search.trim())}
            >
              <UserPlus size={16} />
              <span>{t.home.newPatientBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="skeleton-card" style={{ height: 180 }} />
        ) : patients.length === 0 ? (
          <div className="empty-state">
            <p>{t.patients.empty}</p>
            <button
              className="btn btn-primary"
              onClick={() => onNewPatient(search.trim())}
            >
              <UserPlus size={16} />
              <span>{t.home.newPatientBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.patients.fullName}</th>
                  <th>{t.patients.phone}</th>
                  <th>{t.patients.dob}</th>
                  <th>ИИН</th>
                  <th>{t.patients.visitsCount}</th>
                  <th style={{ textAlign: 'right' }}>{t.patients.details}</th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr
                    key={p.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onOpenPatient(p.id)}
                  >
                    <td>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {p.full_name}
                      </div>
                      {p.allergies && (
                        <span className="badge badge-warning icon-inline" style={{ marginTop: 4 }}>
                          <AlertTriangle size={12} />
                          <span>{p.allergies}</span>
                        </span>
                      )}
                    </td>
                    <td>{p.phone || '—'}</td>
                    <td>{formatDisplayDate(p.date_of_birth)}</td>
                    <td>{p.iin_masked || '—'}</td>
                    <td>
                      <span className="badge badge-neutral">
                        {p.visit_count || 0}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPatient(p.id);
                        }}
                      >
                        <span>{t.home.openPatient}</span>
                        <ArrowRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
