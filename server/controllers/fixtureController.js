const Fixture = require('../models/Fixture');
const Competition = require('../models/Competition');
const Player = require('../models/Player');
const mongoose = require('mongoose');
const {
  generateLeagueFixtures,
  generateKnockoutFixtures,
  ROUND_NAMES,
  generateFirstRoundFixtures,
  generateNextRoundFixtures,
  calculateTotalRounds,
  pairPlayers,
  shuffleArray,
  

} = require('../utils/fixtureGenerator');
const { calculateStandings } = require('../utils/standingsCalculator');
let ioInstance;

// Helper function to calculate match dates
const calculateMatchDate = (fixtureIndex) => {
  const startDate = new Date();
  const weeksToAdd = Math.floor(fixtureIndex / 10); // 10 matches per week
  startDate.setDate(startDate.getDate() + (weeksToAdd * 7));
  return startDate;
};

exports.setIOInstance = (io) => {
  ioInstance = io;
};

exports.createFixturesForLeague = async (req, res) => {
  const { competitionId } = req.params;

  try {
    const competition = await Competition.findById(competitionId)
      .populate('players', 'name _id');
    
    if (!competition) {
      return res.status(404).json({ error: 'Competition not found' });
    }

    // Validate competition type
    const allowedTypes = ['ELITE_LEAGUE', 'PRO_LEAGUE', 'SUPER_LEAGUE', 
                         'ROOKIE_LEAGUE', 'FRIENDLY_LEAGUE', 'LEAGUE'];
    if (!allowedTypes.includes(competition.type)) {
      return res.status(400).json({
        error: 'Invalid competition type for league fixtures',
        allowedTypes
      });
    }

    // Process players
    const validPlayers = competition.players
      .filter(p => p?._id)
      .map(p => ({
        id: p._id.toString(),
        name: p.name || `Player ${p._id.toString().slice(-4)}`
      }));

    if (validPlayers.length < 2 || validPlayers.length > 20) {
      return res.status(400).json({
        error: validPlayers.length < 2 ? 'Not enough valid players' : 'Maximum 20 players allowed',
        playerCount: validPlayers.length
      });
    }

    // Generate fixtures
    const playerMap = new Map(validPlayers.map(p => [p.id, p.name]));
    const rawFixtures = generateLeagueFixtures(
      validPlayers.map(p => p.id),
      playerMap
    );

    // Add competition metadata
    const fixturesData = rawFixtures.map((f, index) => ({
      ...f,
      competitionId,
      matchDate: calculateMatchDate(index),
      status: 'pending',
      createdAt: new Date()
    }));

    // Remove transaction logic and use bulk operations
    await Fixture.deleteMany({ competitionId });
    const insertedFixtures = await Fixture.insertMany(fixturesData);
    
    const roundNumbers = [...new Set(insertedFixtures.map(f => 
      parseInt(f.round.match(/Matchday (\d+)/)?.[1] || '1')))
    ];
    
    await Competition.findByIdAndUpdate(
      competitionId,
      {
        status: 'ongoing',
        fixtureGeneratedAt: new Date(),
        currentRound: { index: 0, name: 'Matchday 1' },
        totalRounds: Math.max(...roundNumbers) || 1
      }
    );

    res.status(201).json({
      success: true,
      message: `${insertedFixtures.length} league fixtures generated`,
      fixtureCount: insertedFixtures.length
    });

  } catch (err) {
    console.error('League Fixture Error:', err);
    const errorMessage = process.env.NODE_ENV === 'development' 
      ? err.message 
      : 'Fixture generation failed';
    res.status(500).json({ success: false, error: errorMessage });
  }
};
  // Knockout Fixture Management
  exports.generateKnockoutFixturesHandler = async (req, res) => {
    try {
      const competition = await Competition.findById(req.params.competitionId);
      if (!competition) return res.status(404).json({ error: 'Competition not found' });

      // Delete existing fixtures
      await Fixture.deleteMany({ competitionId: competition._id });

      // Generate and save initial fixtures
      const fixtures = generateKnockoutFixtures.initialize(competition);
      await Fixture.insertMany(fixtures);

      // Update competition state
      const initialRound = ROUND_NAMES[competition.players.length][0];
      await Competition.findByIdAndUpdate(competition._id, {
        currentRound: { index: 0, name: initialRound },
        isCompleted: false,
        winner: null
      });

      res.status(201).json({ success: true, data: fixtures });

    } catch (error) {
      res.status(400).json({ 
        success: false,
        error: error.message || 'Failed to initialize knockout fixtures'
      });
    }
  };

  exports.generateNextRoundHandler = async (req, res) => {
    try {
      const competition = await Competition.findById(req.params.competitionId);
      if (!competition) return res.status(404).json({ error: 'Competition not found' });

      // Verify current round completion
      const pendingFixtures = await Fixture.countDocuments({
        competitionId: competition._id,
        round: competition.currentRound.name,
        status: 'pending'
      });

      if (pendingFixtures > 0) {
        return res.status(400).json({
          success: false,
          error: `${pendingFixtures} pending matches in current round`
        });
      }

      // Collect winners
      const currentFixtures = await Fixture.find({
        competitionId: competition._id,
        round: competition.currentRound.name
      });

      const winners = currentFixtures.map(f => {
        if (!f.result) throw new Error(`Missing result for fixture ${f._id}`);
        return f.result === 'home' ? f.homePlayer : f.awayPlayer;
      });

      // Handle final round
      const currentRoundIndex = competition.currentRound.index;
      const totalRounds = ROUND_NAMES[competition.players.length].length;
      
      if (currentRoundIndex >= totalRounds - 1) {
        await Competition.findByIdAndUpdate(competition._id, {
          isCompleted: true,
          winner: winners[0]
        });
        return res.json({ 
          success: true, 
          message: 'Competition completed', 
          winner: winners[0] 
        });
      }

      // Generate next round
      const nextFixtures = generateKnockoutFixtures.nextRound(competition, winners);
      await Fixture.insertMany(nextFixtures);

      // Update competition state
      const nextRoundIndex = currentRoundIndex + 1;
      const nextRoundName = ROUND_NAMES[competition.players.length][nextRoundIndex];
      
      await Competition.findByIdAndUpdate(competition._id, {
        currentRound: { index: nextRoundIndex, name: nextRoundName }
      });

      res.status(201).json({ 
        success: true,
        message: `Generated ${nextFixtures.length} fixtures for ${nextRoundName}`,
        data: nextFixtures
      });

    } catch (error) {
      res.status(400).json({ 
        success: false,
        error: error.message || 'Failed to generate next round'
      });
    }
  };
  exports.getKnockoutCompetitions = async (req, res) => {
    try {
      const competitions = await Competition.find({
        type: { $in: ['KO_REGULAR', 'KO_CLUBS', 'KO_BASE','LEAGUE'] }
      }).sort({ createdAt: -1 });
      
      res.status(200).json(competitions);
    } catch (error) {
      console.error('Error fetching knockout competitions:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  };

  exports.getCompetitionById = async (req, res) => {
    try {
      const { competitionId } = req.params;
      
      const competition = await Competition.findById(competitionId)
        .populate('players')
        .populate('winner');
      
      if (!competition) {
        return res.status(404).json({ message: 'Competition not found' });
      }
      
      res.status(200).json(competition);
    } catch (error) {
      console.error('Error fetching competition:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  };
exports.getFixturesByCompetition = async (req, res) => {
  try {
    const fixtures = await Fixture.find({ competitionId: req.params.competitionId })
      .populate('homePlayer', 'name') // Only get the 'name' field
      .populate('awayPlayer', 'name')
      .select('-__v')
      .sort('matchDate round')
      .lean();

    res.status(200).json(fixtures); // no need to format manually now
  } catch (error) {
    console.error('Fixture Fetch Error:', error);
    res.status(500).json({ 
      message: 'Fetch failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

 
// Enhanced knockout fixture generation
exports.generateKoFixtures = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const competition = await Competition.findById(competitionId)
      .populate('players', 'name _id'); // Ensure _id is populated

    if (!competition) return res.status(404).json({ message: 'Competition not found' });
    if (!['KO_REGULAR', 'KO_CLUBS', 'KO_BASE'].includes(competition.type)) {
      return res.status(400).json({ message: 'Invalid competition type' });
    }

    const numPlayers = competition.players.length;
    if (![8, 16, 32].includes(numPlayers)) {
      return res.status(400).json({ message: 'Invalid player count (8/16/32 required)' });
    }

    // Validate and prepare players
    const validPlayers = competition.players
      .filter(p => p?._id)
      .map(p => ({
        id: p._id.toString(),
        name: p.name || `Player ${p._id.toString().slice(-4)}`
      }));
     


    // Generate fixtures
    const playerMap = new Map(validPlayers.map(p => [p.id, p.name]));
    const fixtures = generateFirstRoundFixtures(
      validPlayers.map(p => p.id), 
      competitionId,  
      numPlayers,
      playerMap
    ).map(f => ({
      ...f,
      status: 'pending',
      createdAt: new Date()
    }));
    console.log("Generated fixture objects:", fixtures);


    // Remove transaction logic
    await Fixture.deleteMany({ competitionId });
    const createdFixtures = await Fixture.insertMany(fixtures);

    await Competition.findByIdAndUpdate(
      competitionId,
      {
        status: 'ongoing',
        currentRound: { 
          index: 0, 
          name: createdFixtures[0]?.round || 'Round 1' 
        },
        totalRounds: calculateTotalRounds(numPlayers)
      }
    );

    res.status(201).json({ 
      success: true,
      message: `${fixtures.length} fixtures generated`,
      fixtures: createdFixtures 
    });
    
  } catch (error) {
    console.error('Fixture Generation Error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Generation failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
  // Update fixture result

// Enhanced fixture result update with name validation
exports.updateKoFixtureResult = async (req, res) => {
  try {
    const { fixtureId } = req.params;
    const { homeScore, awayScore } = req.body;

    if (typeof homeScore !== 'number' || typeof awayScore !== 'number' || 
        homeScore < 0 || awayScore < 0) {
      return res.status(400).json({ message: 'Invalid scores' });
    }

    const fixture = await Fixture.findById(fixtureId);
    if (!fixture) return res.status(404).json({ message: 'Fixture not found' });
    if (fixture.status === 'completed') {
      return res.status(400).json({ message: 'Fixture already completed' });
    }

    let result;
    if (homeScore > awayScore) {
      result = 'home';
    } else if (awayScore > homeScore) {
      result = 'away';
    } else {
      return res.status(400).json({ message: 'Knockout matches require a winner' });
    }

    const updatedFixture = await Fixture.findByIdAndUpdate(
      fixtureId,
      {
        homeScore,
        awayScore,
        result,
        status: 'completed',
        completedAt: new Date()
      },
      { new: true }
    );

    // Update competition names if changed
    await updateCompetitionPlayerNames(
      fixture.competitionId,
      fixture.homePlayer,
      fixture.homePlayerName
    );
    
    await updateCompetitionPlayerNames(
      fixture.competitionId,
      fixture.awayPlayer,
      fixture.awayPlayerName
    );

    res.status(200).json({
      message: 'Result updated',
      fixture: updatedFixture
    });
  } catch (error) {
    console.error('Result Update Error:', error);
    res.status(500).json({ 
      message: 'Update failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
async function updateCompetitionPlayerNames(competitionId, playerId, storedName) {
  const currentPlayer = await Player.findById(playerId);
  if (currentPlayer.name !== storedName) {
    await Fixture.updateMany(
      { competitionId, $or: [{ homePlayer: playerId }, { awayPlayer: playerId }] },
      { $set: { 
        'homePlayerName': currentPlayer.name,
        'awayPlayerName': currentPlayer.name 
      } }
    );
    await Standings.updateMany(
      { competition: competitionId, player: playerId },
      { $set: { playerName: currentPlayer.name } }
    );
  }
}
  exports.advanceToNextRound = async (req, res) => {
    try {
      const { competitionId, currentRound } = req.body;
      
      // Validate input
      if (!competitionId || !currentRound) {
        return res.status(400).json({ message: 'Competition ID and current round are required' });
      }

      // Get competition details
      const competition = await Competition.findById(competitionId);
      if (!competition) {
        return res.status(404).json({ message: 'Competition not found' });
      }

      // Check current round fixtures
      const currentRoundFixtures = await Fixture.find({
        competitionId,
        round: currentRound
      });

      if (currentRoundFixtures.length === 0) {
        return res.status(404).json({ message: 'No fixtures found for the current round' });
      }

      // Verify all fixtures are completed
      const incompleteFixtures = currentRoundFixtures.filter(f => f.status !== 'completed');
      if (incompleteFixtures.length > 0) {
        return res.status(400).json({ 
          message: 'Complete all current round matches before advancing' 
        });
      }

      // Handle final round
      if (currentRound === 'Final') {
        const finalFixture = currentRoundFixtures[0];
        const winnerId = finalFixture.result === 'home' 
          ? finalFixture.homePlayer 
          : finalFixture.awayPlayer;

        await Competition.findByIdAndUpdate(competitionId, {
          status: 'completed',
          isCompleted: true,
          winner: winnerId
        });

        return res.status(200).json({
          message: 'Tournament completed successfully',
          winnerId
        });
      }

      // Generate next round fixtures
      const nextRoundFixtures = generateNextRoundFixtures(
        currentRoundFixtures,
        competitionId,
        currentRound,
        competition.numberOfPlayers
      );

      // Save new fixtures and update competition
      const createdFixtures = await Fixture.insertMany(nextRoundFixtures);
      const nextRoundName = createdFixtures[0].round;

      await Competition.findByIdAndUpdate(competitionId, {
        currentRound: { 
          index: competition.currentRound.index + 1,
          name: nextRoundName
        }
      });

      res.status(201).json({
        message: `Advanced to ${nextRoundName} successfully`,
        fixtures: createdFixtures
      });

    } catch (error) {
      console.error('Advancement error:', error);
      res.status(500).json({
        message: 'Server error during round advancement',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
      });
    }
  };
  // Update competition status
  exports.updateCompetitionStatus = async (req, res) => {
    try {
      const { competitionId } = req.params;
      const { status } = req.body;
      
      if (!['upcoming', 'ongoing', 'completed'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status value' });
      }
      
      const competition = await Competition.findByIdAndUpdate(
        competitionId,
        { status },
        { new: true }
      );
      
      if (!competition) {
        return res.status(404).json({ message: 'Competition not found' });
      }
      
      res.status(200).json({
        message: 'Competition status updated successfully',
        competition
      });
    } catch (error) {
      console.error('Error updating competition status:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  };

  // Set competition winner
  exports.setCompetitionWinner = async (req, res) => {
    try {
      const { competitionId } = req.params;
      const { winnerId } = req.body;
      
      if (!winnerId) {
        return res.status(400).json({ message: 'Winner ID is required' });
      }
      
      // Check if the player exists in the competition
      const competition = await Competition.findOne({
        _id: competitionId,
        players: winnerId
      });
      
      if (!competition) {
        return res.status(404).json({ 
          message: 'Competition not found or the specified player is not part of this competition' 
        });
      }
      
      // Update competition with winner and status
      const updatedCompetition = await Competition.findByIdAndUpdate(
        competitionId,
        {
          winner: winnerId,
          status: 'completed',
          isCompleted: true
        },
        { new: true }
      );
      
      res.status(200).json({
        message: 'Competition winner set successfully',
        competition: updatedCompetition
      });
    } catch (error) {
      console.error('Error setting competition winner:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  };
  // Common Methods
  exports.getCompetitionFixtures = async (req, res) => {
    try {
      const fixtures = await Fixture.find({ competitionId: req.params.competitionId })
        .populate('homePlayer awayPlayer', 'name')
        .sort('matchDate round');
      
      res.json({ success: true, data: fixtures });
    } catch (err) {
      res.status(500).json({ 
        success: false,
        error: 'Failed to fetch fixtures'
      });
    }
  };

exports.updateFixtureResult = async (req, res) => {
  try {
    const { fixtureId } = req.params;
    const { homeScore, awayScore } = req.body;

    // 1. Validate inputs
    if (homeScore === undefined || awayScore === undefined) {
      return res.status(400).json({ 
        success: false,
        error: 'Both homeScore and awayScore are required' 
      });
    }

    // Convert to numbers if strings
    const home = Number(homeScore);
    const away = Number(awayScore);

    if (isNaN(home) || isNaN(away)) {
      return res.status(400).json({ 
        success: false,
        error: 'Scores must be valid numbers' 
      });
    }

    // 2. Find and update fixture
    const result = home > away ? 'home' : away > home ? 'away' : 'draw';
    
    const updatedFixture = await Fixture.findByIdAndUpdate(
      fixtureId,
      {
        homeScore: home,
        awayScore: away,
        status: 'completed',
        result,
        completedAt: new Date()
      },
      { new: true, runValidators: true }
    ).populate('homePlayer awayPlayer', 'name _id');

    if (!updatedFixture) {
      return res.status(404).json({ 
        success: false,
        error: 'Fixture not found' 
      });
    }

    // 3. Prepare response
    const response = {
      success: true,
      data: updatedFixture
    };

    // 4. Handle competition updates if needed
    if (updatedFixture.competition) {
      const competition = await Competition.findById(updatedFixture.competition);
      
      if (competition?.type === 'LEAGUE') {
        response.standings = await calculateStandings(competition._id);
        
        // Real-time update if using Socket.io
        if (ioInstance) {
          ioInstance.emit('standings_update', {
            competitionId: competition._id,
            standings: response.standings
          });
        }
      }
    }

    res.json(response);

  } catch (err) {
    console.error('Result Update Error:', err);
    
    // Handle specific error types
    let statusCode = 500;
    let errorMessage = 'Failed to update result';
    
    if (err.name === 'ValidationError') {
      statusCode = 400;
      errorMessage = err.message;
    } else if (err.name === 'CastError') {
      statusCode = 400;
      errorMessage = 'Invalid fixture ID';
    }

    res.status(statusCode).json({ 
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Additional Methods
exports.getOngoingCompetitions = async (req, res) => {
  try {
    const competitions = await Competition.find({ status: 'ongoing' })
      .select('name type startDate currentRound');
    res.json({ success: true,  count: competitions.length,
 data: competitions });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch ongoing competitions'
    });
  }
};
exports.getUpcomingCompetitions = async (req, res) => {
  try {
    const competitions = await Competition.find({ status: 'upcoming' })
      .select('name type startDate currentRound');
    res.json({ success: true, data: competitions });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch ongoing competitions'
    });
  }
};