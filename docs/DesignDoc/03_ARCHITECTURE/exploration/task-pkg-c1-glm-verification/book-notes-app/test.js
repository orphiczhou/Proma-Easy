const http = require('http');
console.log('starting...');
const s = http.createServer((req, res) => { res.end('ok'); });
s.listen(3005, () => { console.log('up'); s.close(); console.log('closed'); });
