const express = require("express");
const { postSend, getSmtpInfo } = require("../controllers/emailController");

const router = express.Router();

router.get("/email/smtp", getSmtpInfo);
router.post("/email/send", postSend);

module.exports = router;
