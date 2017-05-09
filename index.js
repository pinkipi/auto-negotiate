const AUTO_ACCEPT_THRESHOLD		= 1,			// Automatically accepts offers for *equal or more than* the specified amount (0 to disable).
	AUTO_REJECT_THRESHOLD		= 0.75,			/*	Automatically declines offers for *less* than the specified amount (or AUTO_ACCEPT_THRESHOLD).
													Example: 0.75 will decline offers for less than 75% of the asking price (0 to disable).
												*/
	UNATTENDED_MANUAL_NEGOTIATE	= false,		/* Allows the user to click the Accept button once, and the negotiation will be handled automatically.
													Warning: Use this at your own risk. Recommended to set Bargain to a seperate chat tab to prevent
													clicking accidentally.
												*/
	DELAY_ACTIONS 				= true,			// Simulate human-like response times.
	ACTION_DELAY_LONG_MS		= [1200, 2600],	// [Min, Max]
	ACTION_DELAY_SHORT_MS		= [400, 800]	// [Min, Max]

const TYPE_NEGOTIATION_PENDING = 35,
	TYPE_NEGOTIATION = 36

const sysmsg = require('tera-data-parser').sysmsg

module.exports = function AutoNegotiate(dispatch) {
	let recentDeals = UNATTENDED_MANUAL_NEGOTIATE ? {} : null,
		pendingDeals = [],
		currentDeal = null,
		currentContract = null,
		actionTimeout = null,
		cancelTimeout = null

	dispatch.hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, event => {
		// Remove old deals that haven't been processed yet
		for(let i = 0; i < pendingDeals.length; i++) {
			let deal = pendingDeals[i]

			if(deal.playerId == event.playerId && deal.listing == event.listing) pendingDeals.splice(i--, 1)
		}

		if(comparePrice(event.offeredPrice, event.sellerPrice) != 0) {
			pendingDeals.push(event)
			queueNextDeal(true)
			return false
		}
		else if(UNATTENDED_MANUAL_NEGOTIATE) {
			let dealId = event.playerId + '-' + event.listing

			if(recentDeals[dealId]) clearTimeout(recentDeals[dealId].timeout)

			recentDeals[dealId] = event
			recentDeals[dealId].timeout = setTimeout(() => { delete recentDeals[dealId] }, 30000)
		}
	})

	dispatch.hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
		if(currentDeal) {
			if(!event.ok) endDeal()

			return false
		}
	})

	dispatch.hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
		if(currentDeal) {
			if(event.buyerStage == 2 && event.sellerStage < 2) {
				let deal = currentDeal

				// This abandoned timeout is not a good design, but it's unlikely that it will cause any issues
				setTimeout(() => {
					if(currentDeal && deal.playerId == currentDeal.playerId && deal.listing == currentDeal.listing && event.price.toNumber() >= currentDeal.offeredPrice.toNumber()) {
						dispatch.toServer('C_TRADE_BROKER_DEAL_CONFIRM', 1, {
							listing: currentDeal.listing,
							stage: event.sellerStage + 1
						})
					}
					else endDeal() // We negotiated the wrong one, whoops! - TODO: Inspect sRequestContract.data for price and other info
				}, event.sellerStage == 0 ? rng(ACTION_DELAY_SHORT_MS) : 0)
			}

			return false
		}
	})

	dispatch.hook('S_REQUEST_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = event
			setEndTimeout()
			return false
		}
	})

	dispatch.hook('S_REPLY_REQUEST_CONTRACT', 1, replyOrAccept)
	dispatch.hook('S_ACCEPT_CONTRACT', 1, replyOrAccept)

	dispatch.hook('S_REJECT_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			message(currentDeal.name + ' aborted negotiation.')
			currentContract = null
			endDeal()
			return false
		}
	})

	dispatch.hook('S_CANCEL_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = null
			endDeal()
			return false
		}
	})

	dispatch.hook('S_SYSTEM_MESSAGE', 1, event => {
		if(currentDeal) {
			let msg = event.message.split('\x0b'),
				type = msg[0].startsWith('@') ? sysmsg.maps.get(dispatch.base.protocolVersion).code.get(msg[0].slice(1)) : ''

			//if(type == 'SMT_MEDIATE_DISCONNECT_CANCEL_OFFER_BY_ME' || type == 'SMT_MEDIATE_TRADE_CANCEL_ME') return false
			if(type == 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT') {
				message(currentDeal.name + ' cancelled negotiation.')
				return false
			}
		}
	})

	if(UNATTENDED_MANUAL_NEGOTIATE)
		dispatch.hook('C_REQUEST_CONTRACT', 1, event => {
			if(event.type == 35) {
				let deal = recentDeals[event.data.readUInt32LE(0) + '-' + event.data.readUInt32LE(4)]

				if(deal) {
					currentDeal = deal
					message('Handling negotiation with ' + currentDeal.name + '...')
					process.nextTick(() => {
						dispatch.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: event.type })
					})
				}
			}
		})

	function replyOrAccept(event) {
		if(currentDeal && event.type == TYPE_NEGOTIATION_PENDING) {
			setEndTimeout()
			return false
		}
	}

	// 1 = Auto Accept, 0 = No Action, -1 = Auto-decline
	function comparePrice(offer, seller) {
		if(offer.toNumber() >= seller.toNumber() * AUTO_ACCEPT_THRESHOLD) return 1
		if(offer.toNumber() < seller.toNumber() * AUTO_REJECT_THRESHOLD) return -1
		return 0
	}

	function queueNextDeal(slow) {
		if(!actionTimeout && !currentDeal)
			actionTimeout = setTimeout(tryNextDeal, DELAY_ACTIONS ? rng(slow ? ACTION_DELAY_LONG_MS : ACTION_DELAY_SHORT_MS) : 0)
	}

	function tryNextDeal() {
		actionTimeout = null

		if(!(currentDeal = pendingDeals.shift())) return

		if(comparePrice(currentDeal.offeredPrice, currentDeal.sellerPrice) == 1) {
			message('Attempting to negotiate with ' + currentDeal.name + '...')
			message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			const data = Buffer.alloc(30)
			data.writeUInt32LE(currentDeal.playerId, 0)
			data.writeUInt32LE(currentDeal.listing, 4)

			dispatch.toServer('C_REQUEST_CONTRACT', 1, {
				type: 35,
				unk2: 0,
				unk3: 0,
				unk4: 0,
				name: '',
				data
			})
		}
		else {
			dispatch.toServer('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
				playerId: currentDeal.playerId,
				listing: currentDeal.listing
			})

			message('Declined negotiation from ' + currentDeal.name + '.')
			message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			currentDeal = null
			queueNextDeal()
		}
	}

	function setEndTimeout() {
		clearTimeout(cancelTimeout)
		cancelTimeout = setTimeout(endDeal, pendingDeals.length ? 15000 : 30000)
	}

	function endDeal() {
		clearTimeout(cancelTimeout)

		if(currentContract) {
			message('Negotiation timed out.')

			dispatch.toServer('C_CANCEL_CONTRACT', 1, {
				type: currentContract.type,
				id: currentContract.id
			})
			currentContract = null
			setEndTimeout()
			return
		}

		currentDeal = null
		queueNextDeal()
	}

	function formatGold(gold) {
		gold = gold.toString()

		let str = ''
		if(gold.length > 4) str += '<font color="#ffb033">' + Number(gold.slice(0, -4)).toLocaleString() + 'g</font>'
		if(gold.length > 2) str += '<font color="#d7d7d7">' + gold.slice(-4, -2) + 's</font>'
		str += '<font color="#c87551">' + gold.slice(-2) + 'c</font>'

		return str
	}

	function message(msg) {
		dispatch.toClient('S_CHAT', 1, {
			channel: 24,
			authorID: 0,
			unk1: 0,
			gm: 0,
			unk2: 0,
			authorName: '',
			message: '(Proxy)' + msg
		})
	}

	function rng([min, max]) {
		return min + Math.floor(Math.random() * (max - min + 1))
	}
}