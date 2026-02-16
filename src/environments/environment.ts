import packageInfo from '../../package.json';

export const environment = {
  appVersion: packageInfo.version,
  production: false,
  // Keycloak token endpoint
  authUrl: 'https://auth.prosign-lis.com/realms/orchestrateur/protocol/openid-connect/token',
  pdfUrlEndpoint: 'https://api.prosign-lis.com/sign/',
  // Base API (no token hard-coded here)
  apiUrl: 'https://api.prosign-lis.com',
  // OAuth credentials
  authCredentials: {
    client_id: 'orchestrateur-client',
    username: 'admin',
    password: 'L@ser@dmin',
    grant_type: 'password',
    scope: 'openid',
    client_secret: 'Tl4l8bOksMbu3KJ1GEvfapRZANV7flq5'
  }
};
