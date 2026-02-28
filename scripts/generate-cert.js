const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const certDir = path.join(__dirname, '..', 'certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

(async () => {
	const attrs = [{ name: 'commonName', value: '192.168.137.1' }];
	const pems = await selfsigned.generate(attrs, { days: 365 });

	fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);
	fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);

	console.log('Certificados generados en', certDir);
})();
