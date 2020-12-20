const pgpromise = require('pg-promise')()

const pg = pgpromise({
  username: 'postgres', 
  password: 'postgres', 
  port: 5432,
  database: 'concurrent', 
  ssl: false,
})

module.exports = pg