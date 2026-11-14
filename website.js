//--------CONTSTANTS----------\\
require('dotenv').config();
const crypto = require('crypto');
const path = require('path'),
	express = require('express'),
	session = require('express-session'),
	bodyParser = require('body-parser'),
	paymentRoutes = require('./payment-routes'),
	app = express(),
	MemoryStore = require('memorystore')(session),
	dataDir = path.resolve(`./web`)
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
	throw new Error('SESSION_SECRET must be configured in production.');
}
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
	app.set('view engine', 'html');
	app.use('/', express.static(path.resolve(`${dataDir}/`)));
   
	app.use(
		session({
			store: new MemoryStore({ checkPeriod: 86400000 }),
			secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
			resave: false,
			saveUninitialized: false,
			cookie: {
				httpOnly: true,
				sameSite: 'lax',
				secure: process.env.NODE_ENV === 'production',
				maxAge: 7 * 24 * 60 * 60 * 1000
			}
		})
	);

    app.use(bodyParser.json());
	app.use(
		bodyParser.urlencoded({
			extended: true
		})
	);
	app.use('/', paymentRoutes);


 app.get('/', (req, res) => {
		res.sendFile(__dirname + '/web/index.html')
	})
	app.get('/tos', (req, res) => {
		res.sendFile(__dirname + '/web/terms.html')
	})
	app.get('/policy', (req, res) => {
		res.sendFile(__dirname + '/web/privacy.html')
	})
	app.get('/commands', (req, res) => {
		res.sendFile(__dirname + '/web/commands.html')
	})
	app.get('/premium', (req, res) => {
		res.sendFile(__dirname + '/web/premium.html')
	})
	app.get('/premium/payment-method', (req, res) => {
		res.sendFile(__dirname + '/web/payment-method.html')
	})
	app.get('/premium/payment', (req, res) => {
		res.sendFile(__dirname + '/web/payment.html')
	})
	app.get('/premium/submit', (req, res) => {
		res.sendFile(__dirname + '/web/payment-submit.html')
	})
	app.get('/premium/submitted', (req, res) => {
		res.sendFile(__dirname + '/web/payment-success.html')
	})
	app.get('/login', (req, res) => {
		res.sendFile(__dirname + '/web/account.html')
	})
	app.get('/account', (req, res) => {
		res.sendFile(__dirname + '/web/account.html')
	})
	app.get('/review/:token', (req, res) => {
		res.sendFile(__dirname + '/web/payment-review.html')
	})
	app.get('/faq', (req, res) => {
		res.sendFile(__dirname + '/web/faq.html')
	})


  app.use(function(req, res) {
    res.status(404).sendFile(__dirname + '/web/404.html')
  });
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, '0.0.0.0', () =>
    console.log(`[INFO]: The Website is ready on port ${port}`)
);