import React from 'react';

interface State {
  hasError: boolean;
}

/**
 * Global React Error Boundary (Rule 17).
 * Prevents raw stack traces from appearing in the UI and offers a clean recovery button.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[UI ErrorBoundary]', error.name);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-screen">
          <div className="card" style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
            <h2 style={{ marginBottom: 8 }}>Произошла непредвиденная ошибка интерфейса</h2>
            <p className="muted" style={{ marginBottom: 20 }}>
              Все ваши записи и черновики бережно сохранены. Обновите экран для продолжения работы.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => {
                this.setState({ hasError: false });
                window.location.reload();
              }}
            >
              Обновить страницу
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
