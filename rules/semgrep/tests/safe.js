/* eslint-disable */
const { execFile } = require('child_process');

function doSafe(userInput) {
    const db = getDb();
    
    // Safe query
    db.query("SELECT * FROM users WHERE name = $1", [userInput]);
    
    // Safe command execution
    execFile('ls', [userInput]);
}
