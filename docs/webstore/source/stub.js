window.chrome = {
  runtime: { sendMessage: async (m) => m.type === 'getStatus'
    ? { kilogent: { connState: 'connected', tabCount: 2 }, session: { email: 'sam@acme.example', idToken: 'x' }, ships: ['s1', 's2'] }
    : {} },
  storage: { local: {
    get: async () => ({ 'kilogent.label': 'Work laptop', 'kilogent.blocklist': ['https://bank.example.com', 'https://mail.example.com'], 'kilogent.session': { idToken: 'x' } }),
    set: async () => {} } },
  tabs: { create() {} },
};
window.fetch = async () => new Response(JSON.stringify({ result: { ships: [
  { id: 's1', name: 'Acme Growth' }, { id: 's2', name: 'Research Lab' }, { id: 's3', name: 'Side projects' } ] } }),
  { headers: { 'content-type': 'application/json' } });
