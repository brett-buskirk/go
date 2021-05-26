# Go #
I am trying to create one of my favorite games, an ancient Chinese board game called `Go`.  
The goal is for each player to place `stones` on the board and capture more territory than the other player.  
* One player uses white stones and the other player uses black.
* Once played, a stone cannot be moved.
* Stones can be `captured`, however, if a group of them is surrounded by opposing stones on all orthogonally-adjacent points, as in the image below.
  
![Go capture](assets/go-capture.png)  
  
* In this example, the `black` stones have gained three points of territory and have captured three `white` stones.
* When a game is over, the territory is counted along with captured stones to determine a winner.
* There are more rules, but none of them are important here.  

## `The Problem...` ##
I have built a rough version of `Go`.  
It can be played with each click on the board laying an alternating stone.  
The game can be played as is, but I would really like to add some logic.  
  
### *`How can I implement some kind of system to look for grouping patterns on the board?`* ###  
  
In particulr I would like to be able to determine the following:  
* When a group of stones has a `liberty` (a vacant point adjacent to any stone in the group).
* When an entire group is captured (ie, no `liberties` remaining).
* When a group has only one `liberty` remaining (called `atari`).
* When a player attempts to make a move that returns the game to the previous position (called the `ko` rule, which is designed to prevent infinite repitition).  
  
Surely there is a way to do this without a million lines of code?  
Any advice?