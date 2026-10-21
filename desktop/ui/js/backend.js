(function () {
  'use strict';

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
  }

  class SupabaseClient {
    constructor(config) { this.config = config; this.session = null; }

    async restore() {
      this.session = await window.officeStock.secure.readSession();
      if (this.session && this.session.expires_at && this.session.expires_at < Math.floor(Date.now() / 1000) + 30) {
        await this.refresh();
      }
      return this.session;
    }

    async request(url, options = {}, authenticated = true, retried = false) {
      if (!this.config) throw new ApiError('Supabase is not configured.', 0);
      const headers = new Headers(options.headers || {});
      headers.set('apikey', this.config.publishableKey);
      headers.set('Accept', 'application/json');
      if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
      if (authenticated) {
        const token = await this.accessToken();
        if (!token) throw new ApiError('Your session has expired. Sign in again.', 401);
        headers.set('Authorization', `Bearer ${token}`);
      }
      let response;
      try {
        response = await fetch(`${this.config.url}${url}`, {
          ...options, headers, cache: 'no-store', credentials: 'omit',
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        if (error.name === 'TimeoutError') throw new ApiError('Supabase did not respond in time. Check your connection and try again.', 0);
        throw new ApiError('Could not reach Supabase. Check your internet connection and try again.', 0);
      }
      if (response.status === 401 && authenticated && !retried && this.session?.refresh_token) {
        await this.refresh();
        return this.request(url, options, authenticated, true);
      }
      const raw = await response.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = null; }
      }
      if (!response.ok) {
        const code = data?.code || data?.error_code || '';
        let message = data?.message || data?.msg || data?.error_description || data?.error || `Request failed (${response.status}).`;
        if (response.status >= 500) message = 'Supabase could not complete the request. No changes were confirmed; refresh the page before retrying.';
        throw new ApiError(String(message).slice(0, 320), response.status, code);
      }
      return data;
    }

    async accessToken() {
      if (!this.session) await this.restore();
      if (!this.session) return null;
      if (this.session.expires_at && this.session.expires_at <= Math.floor(Date.now() / 1000) + 45) await this.refresh();
      return this.session?.access_token || null;
    }

    async storeSession(session) {
      if (!session?.access_token || !session?.refresh_token) throw new ApiError('Supabase returned an invalid sign-in response.', 0);
      const expiresAt = session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
      this.session = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: expiresAt,
        user: session.user || this.session?.user || null
      };
      await window.officeStock.secure.saveSession(this.session);
      return this.session;
    }

    async signIn(email, password) {
      const data = await this.request('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email: email.trim().toLowerCase(), password })
      }, false);
      return this.storeSession(data);
    }

    async signUp(name, email, password) {
      return this.request('/auth/v1/signup?redirect_to=' + encodeURIComponent('officestock://auth/callback'), {
        method: 'POST', body: JSON.stringify({
          email: email.trim().toLowerCase(), password,
          data: { name: name.trim() }
        })
      }, false);
    }

    async refresh() {
      if (!this.session?.refresh_token) { this.session = null; return null; }
      try {
        const data = await this.request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', body: JSON.stringify({ refresh_token: this.session.refresh_token })
        }, false);
        return this.storeSession(data);
      } catch (error) {
        if (error.status === 400 || error.status === 401) {
          this.session = null;
          await window.officeStock.secure.clearSession();
        }
        throw error;
      }
    }

    async signOut() {
      const token = this.session?.access_token;
      try {
        if (token) await this.request('/auth/v1/logout', { method: 'POST' }, true);
      } catch (_) { /* Local session removal still signs this copy out while offline. */ }
      this.session = null;
      await window.officeStock.secure.clearSession();
    }

    async changePassword(password) {
      return this.request('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) }, true);
    }

    async changeEmail(email) {
      return this.request('/auth/v1/user?redirect_to=' + encodeURIComponent('officestock://auth/callback'), { method: 'PUT', body: JSON.stringify({ email: email.trim().toLowerCase() }) }, true);
    }

    async sendPasswordReset(email) {
      return this.request('/auth/v1/recover?redirect_to=' + encodeURIComponent('officestock://auth/callback'), {
        method: 'POST', body: JSON.stringify({ email: email.trim().toLowerCase() })
      }, false);
    }

    async list(table, params = {}) {
      const query = new URLSearchParams({ select: '*', ...params });
      return this.request(`/rest/v1/${encodeURIComponent(table)}?${query.toString()}`);
    }

    async one(table, params = {}) {
      const rows = await this.list(table, { ...params, limit: '1' });
      return rows?.[0] || null;
    }

    async insert(table, row, returning = true) {
      return this.request(`/rest/v1/${encodeURIComponent(table)}`, {
        method: 'POST', headers: { Prefer: returning ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(row)
      });
    }

    async update(table, filters, data, returning = true) {
      const query = new URLSearchParams({ ...filters, select: '*' });
      return this.request(`/rest/v1/${encodeURIComponent(table)}?${query.toString()}`, {
        method: 'PATCH', headers: { Prefer: returning ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(data)
      });
    }

    async remove(table, filters) {
      const query = new URLSearchParams(filters);
      return this.request(`/rest/v1/${encodeURIComponent(table)}?${query.toString()}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }

    async rpc(name, args = {}) {
      return this.request(`/rest/v1/rpc/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(args) });
    }
  }

  window.OfficeStockApiError = ApiError;
  window.createOfficeStockClient = (config) => new SupabaseClient(config);
})();
