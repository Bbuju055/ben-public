// Tiny real app for e2e verification tests: a page whose button fetches from a real API.
const PAGE = `<!doctype html>
<html>
  <body>
    <h1>e2e fixture</h1>
    <button id="go">go</button>
    <p id="out"></p>
    <script>
      document.getElementById('go').addEventListener('click', async () => {
        const res = await fetch('/api/greet');
        const data = await res.json();
        document.getElementById('out').textContent = data.msg;
      });
    </script>
  </body>
</html>`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.BEN_E2E_PORT ?? 4923),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/greet') {
      return Response.json({ msg: process.env.BEN_E2E_GREETING ?? 'hello from the api' });
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
  },
});

console.log(`fixture app ready on ${server.port}`);
