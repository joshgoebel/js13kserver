"use strict";

const fs = require('fs');
const archiver = require('archiver');
const express = require('express');
const session = require('express-session');
const parser = require('body-parser');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const code = fs.readFileSync('./public/server.js', 'utf8');
const shared = fs.existsSync('./public/shared.js') ? fs.readFileSync('./public/shared.js', 'utf8') : '';
const storage = require('./lib/storage');
const limit = 13 * 1024;
const chalk = require('chalk');
const { minify } = require("terser");
const gulp = require('gulp');
const runMode = process.env.NODE_ENV || 'development'
const isDevelopment = !!(runMode === 'development')
const isProduction = !!(runMode === 'production')
const isTest = !!(runMode === 'test')

const { execSync } = require("child_process");

// gulp stuff
var gulpif =    require('gulp-if');
var terser =    require('gulp-terser')


let packageSize = 0;
let production = true

function createSandbox() {
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Buffer,
        storage: storage.interface,
        io: io
    };

    Object.defineProperty(sandbox, 'module', {
        enumerable: true,
        configurable: false,
        writable: false,
        value: Object.create(null)
    });
    sandbox.module.exports = Object.create(null);
    sandbox.exports = sandbox.module.exports;
    return sandbox;
};

const build_shared =  () => {
    return gulp.src("public/shared.js")
    //   .pipe(rollup({
    //   }, {
    //     format: "iife",
    //     name: "IIFE"
    //   }))
    //   .pipe(concat('build.js'))
      .pipe(gulpif(production, terser()))
      .pipe(gulp.dest('build'));
  };

const build_client =  () => {
    return gulp.src("public/client.js")
//   .pipe(rollup({
//   }, {
//     format: "iife",
//     name: "IIFE"
//   }))
//   .pipe(concat('build.js'))
    .pipe(gulpif(production, terser()))
    .pipe(gulp.dest('build'));
};

const build_server =  () => {
    return gulp.src("public/server.js")
    //   .pipe(rollup({
    //   }, {
    //     format: "iife",
    //     name: "IIFE"
    //   }))
    //   .pipe(concat('build.js'))
        .pipe(gulpif(production, terser()))
        .pipe(gulp.dest('build'));
    };


 async function createZip() {
    execSync("rm -f build/*")

    packageSize = -1;

    await build_shared();
    await build_client();
    await build_server();

    console.log(execSync("ls -l build").toString())
    return  new Promise((resolve, reject) => {
        const archive = archiver('zip', {zlib: { level: 9 }});
        const output = fs.createWriteStream('dist.zip');
        output.on('close', () => {
            packageSize = archive.pointer();
            console.log(execSync("ls -l dist.zip").toString())
            resolve(packageSize);
        });
        output.on('error', (error) => {
            packageSize = -1;
            reject(error);
        })
        archive.on('error', (error) => {
            packageSize = -1;
            reject(error);
        })
        archive.pipe(output);
        archive.directory('build/', '');
        archive.finalize();
    })
};

function recurrentLogStorageSize() {
    let lastStoragePct = -1;
    function logStorageSize() {
        let storageSize = storage.interface.size();
        let pct = storageSize ? storageSize / limit * 100 : 0;
        if (lastStoragePct !== pct) {
            let color = pct <= 100 ? chalk.green : chalk.red;
            console.log(color(`Storage: ${storageSize} byte / ${pct.toFixed(2)}%`));
            lastStoragePct = pct;
        }
    }
    logStorageSize();
    setInterval(logStorageSize, 2000);
};

app.set('port', (process.env.PORT || 3000))
    .set('storage', process.env.DATABASE_URL || 'sqlite:storage.sqlite')
    .get('/server-info', (req, res) => {
        let storageSize = storage.interface.size();
        res.set('Content-Type', 'text/plain').send([
            `Package: ${packageSize} byte / ${(packageSize ? packageSize / limit * 100 : 0).toFixed(2)}%`,
            `Storage: ${storageSize} byte / ${(storageSize ? storageSize / limit * 100 : 0).toFixed(2)}%`
        ].join("\n"));
    })
    .use(express.static('public'))
    .use(session({ secret: 'js13kserver', saveUninitialized: false, resave: false }));

storage.init(app.get('storage')).then(() => {
    const sandbox = createSandbox();
    require('vm').runInNewContext(shared + '\n' + code, sandbox);
    if (typeof sandbox.module.exports == 'function') {
        io.on('connection', sandbox.module.exports);
    } else if (typeof sandbox.module.exports == 'object') {
        app.use(parser.urlencoded({ extended: true }))
            .use(parser.json());
        for (let route in sandbox.module.exports) {
            if (route == 'io') {
                io.on('connection', sandbox.module.exports[route]);
            } else {
                app.all('/' + route, sandbox.module.exports[route])
            }
        }
    }
    server.listen(app.get('port'), async () => {
        console.log(chalk.blue(`Server started in ${runMode} mode at port ${app.get('port')}`));
        await createZip()
        // .then(()=> {
            if (isDevelopment) {
                let pct = packageSize / limit * 100;
                let color = pct <= 100 ? chalk.green : chalk.red;
                console.log(color(`Package: ${packageSize} byte / ${pct.toFixed(2)}%`));
                recurrentLogStorageSize();
            }
        // })
        // .catch((err)=> {
        //     console.error(err.message)
        // });
    });
}).catch(err => {
    console.error(err);
});
