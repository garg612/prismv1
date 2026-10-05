/* eslint-disable */
const { exec } = require('child_process');

function doDangerous(userInput) {
    const db = getDb();
    
    // SQL Injection
    db.query("SELECT * FROM users WHERE name = '" + userInput + "'");
    
    // Command Injection
    exec(userInput);
    
    // Best practice violation
    console.log("Doing dangerous stuff");
}
