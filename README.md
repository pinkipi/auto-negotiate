Automatically accepts or declines Trade Broker negotiations. Settings can be configured by editing `tera-proxy/settings/auto-negotiate.json`.

## Settings
### acceptThreshold
Automatically accepts offers for >= specified amount, prioritised over rejectThreshold (0 to disable).
### rejectThreshold
Automatically declines offers for < specified amount. Example: 0.75 will decline offers for less than 75% of the asking price (0 to disable).
### unattendManualNegotiate
Allows the user to click the Accept button once, and the negotiation will be handled automatically. **Warning:** Use this at your own risk. Recommended to set Bargain to a seperate chat tab to prevent clicking accidentally.
### delayActions
#### enable
Simulate human-like response times.
#### longRng
(\[Min, Max\]) Used for initial transaction.
#### shortRng
(\[Min, Max\]) Used for sequential transactions and dialogs.