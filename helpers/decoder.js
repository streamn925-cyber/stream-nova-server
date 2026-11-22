// helpers/decoder.js

const decrypt = function (data, key) {
    const c = Array.from(key).map(char => char.charCodeAt(0));
    const s = Buffer.from(data, 'base64').toString('binary');
    let result = '';
    for (let i = 0; i < s.length; i++) {
        result += String.fromCharCode(s.charCodeAt(i) ^ c[i % c.length]);
    }
    return Buffer.from(result, 'binary').toString('utf8');
};

module.exports = { decrypt };
